/**
 * Provably wasted CI time, beyond flakes.
 *
 * ADR-0006: flake detection covers only ~32% of repos, so the analyzer also
 * measures waste categories that exist everywhere and need no rerun to prove.
 *
 * Everything here is measured from job timestamps. Nothing is extrapolated —
 * where we have not inspected a job, we say so rather than estimating.
 */

import type { Job, WorkflowRun } from "../github/client.ts";

export type WasteKind = "cancelled" | "broken-window";

export interface WasteFinding {
  repo: string;
  kind: WasteKind;
  workflow: string;
  job: string;
  occurrences: number;
  wastedSeconds: number;
  runner: string;
  runnerLabels: string[];
  detail: string;
  lastSeen: string;
}

/**
 * A job failing this many times in a row is treated as a broken window: the
 * signal is being ignored, so every further run of it burns time for nothing.
 * Below this, consecutive failures are just a bug someone is actively fixing.
 */
const BROKEN_WINDOW_MIN_CONSECUTIVE = 5;

const durationSeconds = (job: Job): number =>
  Math.max(0, Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1_000));

export interface WasteInput {
  repo: string;
  /** Runs in the window, newest first is not required. */
  runs: WorkflowRun[];
  /** Jobs we actually fetched, keyed by run id. Partial by design. */
  jobsByRun: Map<number, Job[]>;
}

/**
 * Cancelled work: the run was stopped and its output discarded.
 *
 * Note this is often *correct* — superseding an in-flight run when a newer
 * commit lands is good practice. It is reported as thrown-away compute, and
 * the remedy is fewer redundant triggers, not disabling cancellation.
 */
function cancelledWaste({ repo, runs, jobsByRun }: WasteInput): WasteFinding[] {
  const groups = new Map<string, WasteFinding>();

  for (const run of runs) {
    if (run.conclusion !== "cancelled") continue;
    for (const job of jobsByRun.get(run.id) ?? []) {
      // A job that never started cost nothing; only running work was thrown away.
      if (job.conclusion !== "cancelled" || !job.started_at || !job.completed_at) continue;
      const seconds = durationSeconds(job);
      if (seconds <= 0) continue;

      const key = `${run.name}|${job.name}`;
      const existing = groups.get(key);
      if (existing) {
        existing.occurrences += 1;
        existing.wastedSeconds += seconds;
        if (job.started_at > existing.lastSeen) existing.lastSeen = job.started_at;
        continue;
      }
      groups.set(key, {
        repo,
        kind: "cancelled",
        workflow: run.name,
        job: job.name,
        occurrences: 1,
        wastedSeconds: seconds,
        runner: job.labels?.[0] ?? "unknown",
        runnerLabels: job.labels ?? [],
        detail: "Run cancelled before finishing; the work was discarded",
        lastSeen: job.started_at,
      });
    }
  }

  return [...groups.values()];
}

/**
 * Jobs left red for many consecutive runs. Nobody is acting on the result, so
 * the compute buys nothing.
 */
function brokenWindows({ repo, runs, jobsByRun }: WasteInput): WasteFinding[] {
  // Oldest → newest so "consecutive" means what it says.
  const ordered = [...runs].sort((a, b) => a.run_started_at.localeCompare(b.run_started_at));

  const streaks = new Map<
    string,
    {
      current: number;
      currentSeconds: number;
      best: number;
      seconds: number;
      runner: string;
      labels: string[];
      last: string;
    }
  >();

  for (const run of ordered) {
    // A successful RUN means every job in it passed. We never fetch jobs for
    // successful runs, so without this the streak would survive across them and
    // "consecutive failures" would silently degrade into "failures in total" —
    // which is a completely different, and far weaker, claim.
    if (run.conclusion === "success") {
      for (const [key, entry] of streaks) {
        if (key.startsWith(`${run.name}|`)) {
          entry.current = 0;
          entry.currentSeconds = 0;
        }
      }
      continue;
    }

    const jobs = jobsByRun.get(run.id);
    if (!jobs) continue; // not inspected and not known-green — say nothing

    for (const job of jobs) {
      const key = `${run.name}|${job.name}`;
      const entry =
        streaks.get(key) ??
        {
          current: 0,
          currentSeconds: 0,
          best: 0,
          seconds: 0,
          runner: job.labels?.[0] ?? "unknown",
          labels: job.labels ?? [],
          last: job.started_at,
        };

      if (job.conclusion === "failure") {
        entry.current += 1;
        entry.currentSeconds += durationSeconds(job);
        if (entry.current > entry.best) {
          // Report the time burned by the longest streak, not by every failure
          // this job ever had — the claim is about the streak.
          entry.best = entry.current;
          entry.seconds = entry.currentSeconds;
          entry.last = job.started_at;
        }
      } else if (job.conclusion === "success") {
        entry.current = 0;
        entry.currentSeconds = 0;
      }
      streaks.set(key, entry);
    }
  }

  const findings: WasteFinding[] = [];
  for (const [key, entry] of streaks) {
    if (entry.best < BROKEN_WINDOW_MIN_CONSECUTIVE) continue;
    const [workflow, job] = key.split("|") as [string, string];
    findings.push({
      repo,
      kind: "broken-window",
      workflow,
      job,
      occurrences: entry.best,
      wastedSeconds: entry.seconds,
      runner: entry.runner,
      runnerLabels: entry.labels,
      detail: `Failed ${entry.best} runs in a row — the result is not being acted on`,
      lastSeen: entry.last,
    });
  }

  return findings;
}

export function findWaste(input: WasteInput): WasteFinding[] {
  return [...cancelledWaste(input), ...brokenWindows(input)].sort(
    (a, b) => b.wastedSeconds - a.wastedSeconds,
  );
}
