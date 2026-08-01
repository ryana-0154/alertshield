/**
 * Flake detection.
 *
 * A Confirmed Flake requires proof: the same commit SHA observed both failing
 * and passing for the same job, with no code change between (guaranteed, since
 * attempts of one run share a SHA). Everything weaker is Suspected. See
 * CONTEXT.md for the vocabulary and ADR-0004 for why the line sits here.
 */

import { GitHubClient, type Job, type WorkflowRun } from "../github/client.ts";
import { CauseClassifier, causeFromFailingStep, type CauseVerdict } from "./cause.ts";
import { findWaste, type WasteFinding } from "./waste.ts";

/**
 * GitHub's published per-minute rates, matched by label prefix.
 *
 * Exact-match lookup was wrong: real repos use `windows-2022`, `ubuntu-slim`,
 * `macos-14-large` and dozens of other variants, all of which fell through to
 * zero and were then mislabelled as self-hosted.
 */
const RATE_PREFIXES: [RegExp, number][] = [
  [/^ubuntu/i, 0.008],
  [/^windows/i, 0.016],
  [/^macos/i, 0.08],
];

export type RunnerClass = "hosted" | "self-hosted" | "unknown";

export interface RunnerPricing {
  class: RunnerClass;
  usdPerMinute: number;
}

/**
 * Classify a runner from its labels. Distinguishing "self-hosted, genuinely
 * free" from "we don't recognise this label" matters: reporting $0 for an
 * unrecognised runner silently understates cost.
 */
export function priceRunner(labels: string[]): RunnerPricing {
  if (labels.some((l) => /^self-hosted$/i.test(l))) return { class: "self-hosted", usdPerMinute: 0 };
  for (const label of labels) {
    const match = RATE_PREFIXES.find(([pattern]) => pattern.test(label));
    if (match) return { class: "hosted", usdPerMinute: match[1] };
  }
  return { class: "unknown", usdPerMinute: 0 };
}

/**
 * How a flake was proven. Both forms are equally conclusive: identical code,
 * different outcome. See ADR-0005 for why `same-sha-runs` was added.
 */
export type Evidence = "rerun-attempt" | "same-sha-runs";

export interface ConfirmedFlake {
  repo: string;
  workflow: string;
  job: string;
  headSha: string;
  runId: number;
  /** The failed job whose log was classified. */
  jobId: number;
  runner: string;
  runnerLabels: string[];
  evidence: Evidence;
  failedAttempts: number;
  wastedSeconds: number;
  occurredAt: string;
  failingStep: string | null;
  cause: CauseVerdict | null;
}

export interface SuspectedFlake {
  repo: string;
  workflow: string;
  job: string;
  failures: number;
  totalRuns: number;
  failureRate: number;
  reason: string;
}

export interface DetectionResult {
  repo: string;
  confirmed: ConfirmedFlake[];
  suspected: SuspectedFlake[];
  /** Provably wasted time that is not a flake (ADR-0006). */
  waste: WasteFinding[];
  runsAnalysed: number;
  /** True if the repo had ≥1 run in the trailing 30 days (CONTEXT.md: Active Repo). */
  activeRepo: boolean;
  lastRunAt: string | null;
}

export interface DetectOptions {
  /** Only consider runs started on or after this instant. */
  since?: Date;
  /** Skip log download and fall back to the step heuristic. */
  skipLogs?: boolean;
  /** Concurrent log downloads. */
  concurrency?: number;
  /** Cap on runs fetched. Essential against real repos — see client. */
  maxRuns?: number;
  now?: Date;
}

const durationSeconds = (job: Job): number =>
  Math.max(0, Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1_000));

const failingStepOf = (job: Job): string | null =>
  job.steps?.find((s) => s.conclusion === "failure")?.name ?? null;

/** Suspected tier thresholds — intermittent, not simply broken. */
const SUSPECTED_MIN_FAILURES = 3;
const SUSPECTED_MAX_FAILURE_RATE = 0.3;

async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function detectFlakes(
  client: GitHubClient,
  owner: string,
  repo: string,
  options: DetectOptions = {},
): Promise<DetectionResult> {
  const fullName = `${owner}/${repo}`;
  const now = options.now ?? new Date();
  const allRuns = await client.listWorkflowRuns(owner, repo, options.maxRuns);

  const runs = options.since
    ? allRuns.filter((r) => Date.parse(r.run_started_at) >= options.since!.getTime())
    : allRuns;

  const confirmed: ConfirmedFlake[] = [];

  // --- Confirmed: compare attempts within a single run ----------------------
  //
  // Only reruns can prove a flake, and only the per-attempt endpoint exposes
  // them. Reading /runs/:id/jobs here would return the passing rerun and find
  // nothing at all.
  const rerunRuns = runs.filter((r) => r.run_attempt > 1);

  await pooled(rerunRuns, options.concurrency ?? 8, async (run: WorkflowRun) => {
    const attempts = await Promise.all(
      Array.from({ length: run.run_attempt }, (_, i) =>
        client.listJobsForAttempt(owner, repo, run.id, i + 1),
      ),
    );

    const byJobName = new Map<string, Job[]>();
    for (const jobs of attempts) {
      for (const job of jobs) {
        const list = byJobName.get(job.name) ?? [];
        list.push(job);
        byJobName.set(job.name, list);
      }
    }

    for (const [jobName, jobs] of byJobName) {
      const failures = jobs.filter((j) => j.conclusion === "failure");
      const successes = jobs.filter((j) => j.conclusion === "success");

      // Both outcomes at one SHA is the proof. All-failures is a real break,
      // not a flake, and must never be reported as one.
      if (failures.length === 0 || successes.length === 0) continue;

      const worst = failures[0]!;
      confirmed.push({
        repo: fullName,
        workflow: run.name,
        job: jobName,
        headSha: run.head_sha,
        runId: run.id,
        jobId: worst.id,
        runner: worst.labels?.[0] ?? "unknown",
        runnerLabels: worst.labels ?? [],
        evidence: "rerun-attempt",
        failedAttempts: failures.length,
        wastedSeconds: failures.reduce((total, job) => total + durationSeconds(job), 0),
        occurredAt: worst.started_at,
        failingStep: failingStepOf(worst),
        cause: null,
      });
    }
  });

  // --- Confirmed: the same SHA running more than once, as separate runs -----
  //
  // Merge queues, re-triggered workflows, and pull_request/pull_request_target
  // pairs all produce this. Identical code, different outcome — the same proof
  // a rerun gives. Only 1.5% of runs are ever reran, so without this most repos
  // yield nothing at all (ADR-0005).
  const sameShaGroups = new Map<string, WorkflowRun[]>();
  for (const run of runs) {
    const key = `${run.name}|${run.head_sha}`;
    sameShaGroups.set(key, [...(sameShaGroups.get(key) ?? []), run]);
  }

  const contested = [...sameShaGroups.values()].filter(
    (group) =>
      group.length > 1 &&
      group.some((r) => r.conclusion === "failure") &&
      group.some((r) => r.conclusion === "success"),
  );

  await pooled(contested, options.concurrency ?? 8, async (group) => {
    const jobsByRun = await Promise.all(
      group.map(async (run) => ({ run, jobs: await client.listJobsForRun(owner, repo, run.id) })),
    );

    const byJobName = new Map<string, { run: WorkflowRun; job: Job }[]>();
    for (const { run, jobs } of jobsByRun) {
      for (const job of jobs) {
        byJobName.set(job.name, [...(byJobName.get(job.name) ?? []), { run, job }]);
      }
    }

    for (const [jobName, entries] of byJobName) {
      const failures = entries.filter((e) => e.job.conclusion === "failure");
      const successes = entries.filter((e) => e.job.conclusion === "success");
      if (failures.length === 0 || successes.length === 0) continue;

      // Don't double-count a job already proven via rerun attempts.
      const first = failures[0]!;
      const duplicate = confirmed.some(
        (f) => f.headSha === first.run.head_sha && f.job === jobName && f.workflow === first.run.name,
      );
      if (duplicate) continue;

      confirmed.push({
        repo: fullName,
        workflow: first.run.name,
        job: jobName,
        headSha: first.run.head_sha,
        runId: first.run.id,
        jobId: first.job.id,
        runner: first.job.labels?.[0] ?? "unknown",
        runnerLabels: first.job.labels ?? [],
        evidence: "same-sha-runs",
        failedAttempts: failures.length,
        wastedSeconds: failures.reduce((total, e) => total + durationSeconds(e.job), 0),
        occurredAt: first.job.started_at,
        failingStep: failingStepOf(first.job),
        cause: null,
      });
    }
  });

  // --- One pass over every unsuccessful run --------------------------------
  //
  // Feeds both the Suspected tier and the waste analysis (ADR-0006). Fetching
  // jobs is the expensive part, so it happens once and both consumers read the
  // same map. Successful runs are never fetched: nothing needs them, and they
  // are the overwhelming majority.
  const unsuccessful = runs.filter(
    (r) => r.conclusion === "failure" || r.conclusion === "cancelled",
  );
  const jobsByRun = new Map<number, Job[]>();

  await pooled(unsuccessful, options.concurrency ?? 8, async (run: WorkflowRun) => {
    jobsByRun.set(run.id, await client.listJobsForRun(owner, repo, run.id));
  });

  const waste = findWaste({ repo: fullName, runs, jobsByRun });

  const failureCounts = new Map<string, { workflow: string; job: string; failures: number }>();
  for (const run of unsuccessful) {
    if (run.run_attempt !== 1 || run.conclusion !== "failure") continue;
    for (const job of jobsByRun.get(run.id) ?? []) {
      if (job.conclusion !== "failure") continue;
      const key = `${run.name}\u0000${job.name}`;
      const entry = failureCounts.get(key) ?? { workflow: run.name, job: job.name, failures: 0 };
      entry.failures += 1;
      failureCounts.set(key, entry);
    }
  }

  const runsPerWorkflow = new Map<string, number>();
  for (const run of runs) runsPerWorkflow.set(run.name, (runsPerWorkflow.get(run.name) ?? 0) + 1);

  const confirmedJobKeys = new Set(confirmed.map((f) => `${f.workflow}\u0000${f.job}`));
  const suspected: SuspectedFlake[] = [];

  for (const [key, { workflow, job, failures }] of failureCounts) {
    if (confirmedJobKeys.has(key)) continue; // already proven; don't double-report
    const totalRuns = runsPerWorkflow.get(workflow) ?? 0;
    const failureRate = totalRuns > 0 ? failures / totalRuns : 0;
    if (failures < SUSPECTED_MIN_FAILURES || failureRate > SUSPECTED_MAX_FAILURE_RATE) continue;

    suspected.push({
      repo: fullName,
      workflow,
      job,
      failures,
      totalRuns,
      failureRate: Number(failureRate.toFixed(4)),
      reason: "Intermittent failures never reran, so no same-SHA proof exists",
    });
  }

  // --- Cause attribution ---------------------------------------------------
  if (!options.skipLogs) {
    await pooled(confirmed, options.concurrency ?? 8, async (flake) => {
      try {
        const classifier = new CauseClassifier();
        await client.streamJobLog(owner, repo, flake.jobId, (line) => classifier.feed(line));
        flake.cause = classifier.verdict() ?? causeFromFailingStep(flake.failingStep);
      } catch {
        // Logs expire, and a missing log must not lose the finding.
        flake.cause = causeFromFailingStep(flake.failingStep);
      }
    });
  } else {
    for (const flake of confirmed) flake.cause = causeFromFailingStep(flake.failingStep);
  }

  const lastRun = allRuns.reduce<string | null>(
    (latest, run) => (!latest || run.run_started_at > latest ? run.run_started_at : latest),
    null,
  );

  return {
    repo: fullName,
    confirmed,
    suspected,
    waste,
    runsAnalysed: runs.length,
    activeRepo: lastRun !== null && Date.parse(lastRun) > now.getTime() - 30 * 86_400_000,
    lastRunAt: lastRun,
  };
}

export function usdFor(labels: string[], wastedSeconds: number): number {
  return (wastedSeconds / 60) * priceRunner(labels).usdPerMinute;
}
