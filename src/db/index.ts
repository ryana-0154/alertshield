/**
 * Postgres access: pool, migrations, and the persistence layer.
 *
 * ADR-0003 is enforced at this boundary — nothing here accepts or writes a raw
 * log. The only log-derived value that crosses is `cause.excerpt`, already
 * redacted by the classifier.
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { priceRunner, type ConfirmedFlake, type DetectionResult } from "../detect/index.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env["DATABASE_URL"];
    if (!connectionString) throw new Error("DATABASE_URL is not set (see .env.example)");
    pool = new pg.Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export async function migrate(): Promise<string[]> {
  const db = getPool();
  await db.query(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name),
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      ran.push(file);
    } catch (error) {
      await client.query("rollback");
      throw new Error(`Migration ${file} failed: ${String(error)}`);
    } finally {
      client.release();
    }
  }

  return ran;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function upsertRepo(fullName: string): Promise<number> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into repos (full_name) values ($1)
     on conflict (full_name) do update set full_name = excluded.full_name
     returning id`,
    [fullName],
  );
  return Number(rows[0]!.id);
}

export async function startIngestion(repoId: number): Promise<number> {
  const { rows } = await getPool().query<{ id: string }>(
    "insert into ingestions (repo_id) values ($1) returning id",
    [repoId],
  );
  return Number(rows[0]!.id);
}

export async function finishIngestion(
  ingestionId: number,
  stats: { runsAnalysed: number; apiRequests: number; error?: string },
): Promise<void> {
  await getPool().query(
    `update ingestions
        set finished_at = now(), runs_analysed = $2, api_requests = $3, error = $4
      where id = $1`,
    [ingestionId, stats.runsAnalysed, stats.apiRequests, stats.error ?? null],
  );
}

/**
 * Persist a detection result. Idempotent: re-ingesting an overlapping window
 * updates existing findings rather than duplicating them.
 */
export async function saveResult(repoId: number, result: DetectionResult): Promise<void> {
  const db = getPool();
  const client = await db.connect();

  try {
    await client.query("begin");

    for (const flake of result.confirmed) {
      await client.query(
        `insert into confirmed_flakes (
           repo_id, workflow, job, head_sha, run_id, job_id, evidence, runner,
           runner_labels, runner_class, failed_attempts, wasted_seconds, occurred_at,
           failing_step, cause, cause_pattern_id, cause_confidence, cause_excerpt
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         on conflict on constraint confirmed_flakes_unique do update set
           wasted_seconds   = excluded.wasted_seconds,
           failed_attempts  = excluded.failed_attempts,
           cause            = excluded.cause,
           cause_pattern_id = excluded.cause_pattern_id,
           cause_confidence = excluded.cause_confidence,
           cause_excerpt    = excluded.cause_excerpt`,
        [
          repoId,
          flake.workflow,
          flake.job,
          flake.headSha,
          flake.runId,
          flake.jobId,
          flake.evidence,
          flake.runner,
          flake.runnerLabels,
          priceRunner(flake.runnerLabels).class,
          flake.failedAttempts,
          flake.wastedSeconds,
          flake.occurredAt,
          flake.failingStep,
          flake.cause?.cause ?? null,
          flake.cause?.patternId ?? null,
          flake.cause?.confidence ?? null,
          flake.cause?.excerpt ?? null,
        ],
      );
    }

    for (const suspected of result.suspected) {
      await client.query(
        `insert into suspected_flakes (repo_id, workflow, job, failures, total_runs, failure_rate, reason)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict on constraint suspected_flakes_unique do update set
           failures     = excluded.failures,
           total_runs   = excluded.total_runs,
           failure_rate = excluded.failure_rate,
           observed_at  = now()`,
        [
          repoId,
          suspected.workflow,
          suspected.job,
          suspected.failures,
          suspected.totalRuns,
          suspected.failureRate,
          suspected.reason,
        ],
      );
    }

    for (const item of result.waste) {
      await client.query(
        `insert into waste_findings (
           repo_id, kind, workflow, job, occurrences, wasted_seconds,
           runner, runner_labels, runner_class, detail, last_seen
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict on constraint waste_findings_unique do update set
           occurrences    = excluded.occurrences,
           wasted_seconds = excluded.wasted_seconds,
           detail         = excluded.detail,
           last_seen      = excluded.last_seen,
           updated_at     = now()`,
        [
          repoId,
          item.kind,
          item.workflow,
          item.job,
          item.occurrences,
          item.wastedSeconds,
          item.runner,
          item.runnerLabels,
          priceRunner(item.runnerLabels).class,
          item.detail,
          item.lastSeen,
        ],
      );
    }

    await client.query("update repos set last_ingested_at = now() where id = $1", [repoId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Queries backing the report page
// ---------------------------------------------------------------------------

export interface StoredGroup {
  repo: string;
  workflow: string;
  job: string;
  occurrences: number;
  wastedSeconds: number;
  runner: string;
  runnerClass: string;
  likelyCause: string | null;
  causeConfidence: string | null;
  excerpt: string | null;
  evidence: string;
  lastSeen: string;
}

export interface StoredSuspected {
  repo: string;
  workflow: string;
  job: string;
  failures: number;
  totalRuns: number;
  failureRate: number;
}

/** Ranked confirmed findings. `sinceDays` bounds the window; null means all time. */
export async function loadGroups(sinceDays: number | null, minWastedSeconds = 60): Promise<StoredGroup[]> {
  const { rows } = await getPool().query(
    `select r.full_name                       as repo,
            f.workflow,
            f.job,
            count(*)::int                     as occurrences,
            sum(f.wasted_seconds)::int        as wasted_seconds,
            max(f.runner)                     as runner,
            max(f.runner_class)               as runner_class,
            mode() within group (order by f.cause)            as likely_cause,
            mode() within group (order by f.cause_confidence) as cause_confidence,
            (array_remove(array_agg(f.cause_excerpt order by f.occurred_at desc), null))[1] as excerpt,
            mode() within group (order by f.evidence)         as evidence,
            max(f.occurred_at)                as last_seen
       from confirmed_flakes f
       join repos r on r.id = f.repo_id
      where ($1::int is null or f.occurred_at > now() - ($1 || ' days')::interval)
      group by r.full_name, f.workflow, f.job
     having sum(f.wasted_seconds) >= $2
      order by sum(f.wasted_seconds) desc`,
    [sinceDays, minWastedSeconds],
  );

  return rows.map((row) => ({
    repo: row.repo,
    workflow: row.workflow,
    job: row.job,
    occurrences: row.occurrences,
    wastedSeconds: row.wasted_seconds,
    runner: row.runner,
    runnerClass: row.runner_class,
    likelyCause: row.likely_cause,
    causeConfidence: row.cause_confidence,
    excerpt: row.excerpt,
    evidence: row.evidence,
    lastSeen: new Date(row.last_seen).toISOString(),
  }));
}

export async function loadSuspected(): Promise<StoredSuspected[]> {
  const { rows } = await getPool().query(
    `select r.full_name as repo, s.workflow, s.job, s.failures, s.total_runs, s.failure_rate
       from suspected_flakes s
       join repos r on r.id = s.repo_id
      order by s.failures desc
      limit 100`,
  );
  return rows.map((row) => ({
    repo: row.repo,
    workflow: row.workflow,
    job: row.job,
    failures: row.failures,
    totalRuns: row.total_runs,
    failureRate: Number(row.failure_rate),
  }));
}

export interface RepoSummary {
  fullName: string;
  lastIngestedAt: string | null;
  confirmed: number;
  suspected: number;
  wastedSeconds: number;
}

export async function loadRepos(): Promise<RepoSummary[]> {
  const { rows } = await getPool().query(
    `select r.full_name,
            r.last_ingested_at,
            (select count(*) from confirmed_flakes f where f.repo_id = r.id)::int as confirmed,
            (select count(*) from suspected_flakes s where s.repo_id = r.id)::int as suspected,
            coalesce((select sum(wasted_seconds) from confirmed_flakes f where f.repo_id = r.id), 0)::int
              as wasted_seconds
       from repos r
      order by wasted_seconds desc`,
  );
  return rows.map((row) => ({
    fullName: row.full_name,
    lastIngestedAt: row.last_ingested_at ? new Date(row.last_ingested_at).toISOString() : null,
    confirmed: row.confirmed,
    suspected: row.suspected,
    wastedSeconds: row.wasted_seconds,
  }));
}

export interface StoredWaste {
  repo: string;
  kind: string;
  workflow: string;
  job: string;
  occurrences: number;
  wastedSeconds: number;
  runner: string;
  runnerClass: string;
  detail: string;
  lastSeen: string;
}

/** Non-flake waste, ranked. Uses the same noise floor as confirmed findings. */
export async function loadWaste(minWastedSeconds = 60): Promise<StoredWaste[]> {
  const { rows } = await getPool().query(
    `select r.full_name as repo, w.kind, w.workflow, w.job, w.occurrences,
            w.wasted_seconds, w.runner, w.runner_class, w.detail, w.last_seen
       from waste_findings w
       join repos r on r.id = w.repo_id
      where w.wasted_seconds >= $1
      order by w.wasted_seconds desc
      limit 100`,
    [minWastedSeconds],
  );
  return rows.map((row) => ({
    repo: row.repo,
    kind: row.kind,
    workflow: row.workflow,
    job: row.job,
    occurrences: row.occurrences,
    wastedSeconds: row.wasted_seconds,
    runner: row.runner,
    runnerClass: row.runner_class,
    detail: row.detail,
    lastSeen: new Date(row.last_seen).toISOString(),
  }));
}
