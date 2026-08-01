/**
 * Generates GitHub-shaped Actions fixtures plus a ground-truth manifest.
 *
 * Run with:  npm run fixtures
 *
 * Output lands in tools/fixtures/data/ (gitignored — regenerate, don't commit).
 *
 * Fidelity note: a rerun in GitHub does NOT create a new workflow run. It adds
 * an *attempt* to the existing run, and the default jobs endpoint returns only
 * the latest attempt. A client that reads /runs/:id/jobs and stops there sees
 * the passing rerun and never learns a flake happened. That trap is reproduced
 * faithfully here, because avoiding it is the core of the analyzer's job.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAUSE_BY_STEP,
  REPOS,
  RUNNER_RATES_USD_PER_MINUTE,
  STEP_SEQUENCE,
  type FailingStep,
  type FlakeCause,
  type JobSpec,
  type Pattern,
  type RepoSpec,
} from "./scenarios.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "data");
const SEED = 1337;

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/** mulberry32 — small, fast, seedable. Math.random() would break repeatability. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(SEED);
const randInt = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));

function hexSha(): string {
  let out = "";
  for (let i = 0; i < 40; i += 1) out += "0123456789abcdef"[randInt(0, 15)];
  return out;
}

/** Pick `count` distinct values from `pool` without replacement. */
function sample<T>(pool: T[], count: number): T[] {
  const copy = [...pool];
  const picked: T[] = [];
  while (picked.length < count && copy.length > 0) {
    picked.push(copy.splice(randInt(0, copy.length - 1), 1)[0]!);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Shapes (subsets of GitHub's REST responses — only fields we actually rely on)
// ---------------------------------------------------------------------------

export interface FixtureStep {
  name: string;
  status: "completed";
  conclusion: "success" | "failure" | "skipped";
  number: number;
  started_at: string;
  completed_at: string;
}

export interface FixtureJob {
  id: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  name: string;
  status: "completed";
  conclusion: "success" | "failure";
  started_at: string;
  completed_at: string;
  labels: string[];
  runner_name: string;
  steps: FixtureStep[];
}

export interface FixtureAttempt {
  run_attempt: number;
  run_started_at: string;
  conclusion: "success" | "failure";
  jobs: FixtureJob[];
}

export interface FixtureRun {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  path: string;
  run_number: number;
  event: "push" | "pull_request";
  status: "completed";
  /** Conclusion of the LATEST attempt, matching GitHub's behaviour. */
  conclusion: "success" | "failure";
  workflow_id: number;
  created_at: string;
  updated_at: string;
  run_started_at: string;
  /** Number of the latest attempt. >1 means somebody reran it. */
  run_attempt: number;
  repository: { full_name: string };
  /** Not a GitHub field — the mock server uses it to serve per-attempt jobs. */
  _attempts: FixtureAttempt[];
}

interface ExpectedFlake {
  repo: string;
  workflow: string;
  job: string;
  headSha: string;
  cause: FlakeCause;
  failingStep: FailingStep;
  runner: string;
  failedAttempts: number;
  wastedSeconds: number;
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

let nextJobId = 100_000;
let nextRunId = 900_000;
let nextWorkflowId = 500;

const anchor = new Date(process.env["FIXTURE_NOW"] ?? new Date().toISOString());

interface PlantedPattern {
  job: JobSpec;
  pattern: Pattern;
  workflowName: string;
}

function buildSteps(
  startedAt: Date,
  durationSeconds: number,
  failingStep: FailingStep | null,
): { steps: FixtureStep[]; completedAt: Date } {
  const steps: FixtureStep[] = [];
  let cursor = new Date(startedAt);
  let failed = false;

  STEP_SEQUENCE.forEach((name, index) => {
    // Weight most of the job's wall-clock into the test step.
    const share = name === "Run tests" ? 0.7 : 0.075;
    const stepSeconds = Math.max(1, Math.round(durationSeconds * share));
    const startedIso = cursor.toISOString();

    let conclusion: FixtureStep["conclusion"];
    if (failed) {
      conclusion = "skipped";
    } else if (failingStep === name) {
      conclusion = "failure";
      failed = true;
    } else {
      conclusion = "success";
    }

    // A failing step is cut short; skipped steps consume no time.
    const actualSeconds =
      conclusion === "skipped" ? 0 : conclusion === "failure" ? Math.round(stepSeconds * 0.4) : stepSeconds;
    cursor = new Date(cursor.getTime() + actualSeconds * 1_000);

    steps.push({
      name,
      status: "completed",
      conclusion,
      number: index + 1,
      started_at: startedIso,
      completed_at: cursor.toISOString(),
    });
  });

  return { steps, completedAt: cursor };
}

function buildJob(
  spec: JobSpec,
  runId: number,
  attempt: number,
  headSha: string,
  startedAt: Date,
  failingStep: FailingStep | null,
): FixtureJob {
  const jitter = 1 + (rng() - 0.5) * 0.2;
  const duration = Math.round(spec.durationSeconds * jitter);
  const { steps, completedAt } = buildSteps(startedAt, duration, failingStep);

  return {
    id: nextJobId++,
    run_id: runId,
    run_attempt: attempt,
    head_sha: headSha,
    name: spec.name,
    status: "completed",
    conclusion: failingStep ? "failure" : "success",
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    labels: [spec.runner],
    runner_name: `fake-runner-${spec.runner}`,
    steps,
  };
}

function generateRepo(repo: RepoSpec): { runs: FixtureRun[]; expected: ExpectedFlake[] } {
  const runs: FixtureRun[] = [];
  const expected: ExpectedFlake[] = [];
  const fullName = `${repo.owner}/${repo.name}`;
  const workflowIds = new Map<string, number>();
  for (const wf of repo.workflows) workflowIds.set(wf.name, nextWorkflowId++);

  const totalRuns = repo.runsPerDay * repo.historyDays;
  if (totalRuns === 0) return { runs, expected };

  // Lay down the run skeleton first so patterns can be assigned to slots.
  const slots = Array.from({ length: totalRuns }, (_, i) => {
    const dayIndex = Math.floor(i / repo.runsPerDay);
    const daysAgo = repo.historyDays - dayIndex;
    const started = new Date(anchor.getTime() - daysAgo * 86_400_000);
    started.setUTCHours(randInt(8, 19), randInt(0, 59), randInt(0, 59), 0);
    return { index: i, daysAgo, started, sha: hexSha() };
  });

  // Assign each planted pattern to specific slots, per job.
  const assignments = new Map<string, { pattern: Pattern; failingStep: FailingStep }>();
  const key = (slotIndex: number, wf: string, job: string) => `${slotIndex}|${wf}|${job}`;

  const planted: PlantedPattern[] = repo.workflows.flatMap((wf) =>
    wf.jobs.flatMap((job) => job.patterns.map((pattern) => ({ job, pattern, workflowName: wf.name }))),
  );

  for (const { job, pattern, workflowName } of planted) {
    // "healed" flakes only occur in the older half of the window.
    const eligible =
      pattern.kind === "healed-flake" ? slots.filter((s) => s.daysAgo > 45) : slots;
    for (const slot of sample(eligible, pattern.occurrences)) {
      assignments.set(key(slot.index, workflowName, job.name), {
        pattern,
        failingStep: pattern.failingStep,
      });
    }
  }

  for (const slot of slots) {
    for (const wf of repo.workflows) {
      const runId = nextRunId++;
      const attempts: FixtureAttempt[] = [];

      // How many attempts this run has is decided by the worst pattern in it.
      const jobPatterns = wf.jobs.map((job) => ({
        job,
        assigned: assignments.get(key(slot.index, wf.name, job.name)) ?? null,
      }));

      const needsRerun = jobPatterns.some(
        (j) => j.assigned?.pattern.kind === "confirmed-flake" || j.assigned?.pattern.kind === "healed-flake",
      );
      const stubbornFailure = jobPatterns.some((j) => j.assigned?.pattern.kind === "genuine-failure");
      const attemptCount = needsRerun || stubbornFailure ? 2 : 1;

      for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
        const attemptStart = new Date(slot.started.getTime() + (attempt - 1) * 1_800_000);
        const jobs: FixtureJob[] = [];

        for (const { job, assigned } of jobPatterns) {
          let failingStep: FailingStep | null = null;

          if (assigned) {
            const { kind } = assigned.pattern;
            if (kind === "confirmed-flake" || kind === "healed-flake") {
              // Fails first, passes on rerun — the same-SHA proof.
              failingStep = attempt === 1 ? assigned.failingStep : null;
            } else if (kind === "genuine-failure") {
              failingStep = assigned.failingStep; // broken on every attempt
            } else if (kind === "suspected-flake") {
              failingStep = attempt === 1 ? assigned.failingStep : null;
            }
          }

          const built = buildJob(job, runId, attempt, slot.sha, attemptStart, failingStep);
          jobs.push(built);

          const isConfirmed =
            assigned &&
            (assigned.pattern.kind === "confirmed-flake" || assigned.pattern.kind === "healed-flake") &&
            attempt === 1;

          if (isConfirmed) {
            const wastedSeconds = Math.round(
              (new Date(built.completed_at).getTime() - new Date(built.started_at).getTime()) / 1_000,
            );
            expected.push({
              repo: fullName,
              workflow: wf.name,
              job: job.name,
              headSha: slot.sha,
              cause: CAUSE_BY_STEP[assigned!.failingStep],
              failingStep: assigned!.failingStep,
              runner: job.runner,
              failedAttempts: 1,
              wastedSeconds,
              occurredAt: built.started_at,
            });
          }
        }

        attempts.push({
          run_attempt: attempt,
          run_started_at: attemptStart.toISOString(),
          conclusion: jobs.some((j) => j.conclusion === "failure") ? "failure" : "success",
          jobs,
        });
      }

      // "suspected" runs are never rerun, so a single failed attempt stands alone.
      const suspectedOnly = jobPatterns.some((j) => j.assigned?.pattern.kind === "suspected-flake");
      if (suspectedOnly && attempts.length > 1) attempts.length = 1;

      const latest = attempts[attempts.length - 1]!;

      runs.push({
        id: runId,
        name: wf.name,
        head_branch: rng() > 0.6 ? "main" : `feature/${Math.floor(rng() * 900 + 100)}`,
        head_sha: slot.sha,
        path: wf.path,
        run_number: slot.index + 1,
        event: rng() > 0.5 ? "push" : "pull_request",
        status: "completed",
        conclusion: latest.conclusion,
        workflow_id: workflowIds.get(wf.name)!,
        created_at: slot.started.toISOString(),
        updated_at: latest.jobs[latest.jobs.length - 1]?.completed_at ?? slot.started.toISOString(),
        run_started_at: slot.started.toISOString(),
        run_attempt: latest.run_attempt,
        repository: { full_name: fullName },
        _attempts: attempts,
      });
    }
  }

  return { runs, expected };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(join(DATA_DIR, "runs"), { recursive: true });

  const allExpected: ExpectedFlake[] = [];
  const repoSummaries: unknown[] = [];
  let totalRuns = 0;
  let totalJobs = 0;

  for (const repo of REPOS) {
    const { runs, expected } = generateRepo(repo);
    const fullName = `${repo.owner}/${repo.name}`;
    const jobCount = runs.reduce((n, r) => n + r._attempts.reduce((m, a) => m + a.jobs.length, 0), 0);

    await writeFile(
      join(DATA_DIR, "runs", `${repo.owner}__${repo.name}.json`),
      JSON.stringify(runs, null, 2),
    );

    allExpected.push(...expected);
    totalRuns += runs.length;
    totalJobs += jobCount;

    const lastRun = runs[runs.length - 1];
    repoSummaries.push({
      full_name: fullName,
      private: false,
      note: repo.note,
      runs: runs.length,
      jobs: jobCount,
      confirmedFlakes: expected.length,
      lastRunAt: lastRun?.run_started_at ?? null,
      // Active Repo per CONTEXT.md: ≥1 workflow run in the trailing 30 days.
      activeRepo: runs.some(
        (r) => new Date(r.run_started_at).getTime() > anchor.getTime() - 30 * 86_400_000,
      ),
    });
  }

  const wastedByRepo: Record<string, number> = {};
  const wastedByCause: Record<string, number> = {};
  let usdTotal = 0;

  for (const flake of allExpected) {
    wastedByRepo[flake.repo] = (wastedByRepo[flake.repo] ?? 0) + flake.wastedSeconds;
    wastedByCause[flake.cause] = (wastedByCause[flake.cause] ?? 0) + flake.wastedSeconds;
    const rate = RUNNER_RATES_USD_PER_MINUTE[flake.runner as keyof typeof RUNNER_RATES_USD_PER_MINUTE] ?? 0;
    usdTotal += (flake.wastedSeconds / 60) * rate;
  }

  const manifest = {
    generatedFrom: { seed: SEED, anchor: anchor.toISOString() },
    runnerRatesUsdPerMinute: RUNNER_RATES_USD_PER_MINUTE,
    repos: repoSummaries,
    totals: {
      runs: totalRuns,
      jobs: totalJobs,
      confirmedFlakes: allExpected.length,
      wastedMinutes: Math.round(allExpected.reduce((n, f) => n + f.wastedSeconds, 0) / 60),
      derivedUsd: Number(usdTotal.toFixed(2)),
      wastedMinutesByRepo: Object.fromEntries(
        Object.entries(wastedByRepo).map(([k, v]) => [k, Math.round(v / 60)]),
      ),
      wastedMinutesByCause: Object.fromEntries(
        Object.entries(wastedByCause).map(([k, v]) => [k, Math.round(v / 60)]),
      ),
    },
    confirmedFlakes: allExpected,
  };

  await writeFile(join(DATA_DIR, "expected.json"), JSON.stringify(manifest, null, 2));

  console.log(`Fixtures written to ${DATA_DIR}`);
  console.table(repoSummaries);
  console.log(
    `\nGround truth: ${manifest.totals.confirmedFlakes} confirmed flakes, ` +
      `${manifest.totals.wastedMinutes} wasted minutes, $${manifest.totals.derivedUsd} derived.\n` +
      `Assert against tools/fixtures/data/expected.json.`,
  );
}

await main();
