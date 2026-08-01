/**
 * Waste analysis tests (ADR-0006).
 *
 * Pure functions over synthetic job data — no network, no database.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { findWaste, type WasteInput } from "../src/detect/waste.ts";
import type { Job, WorkflowRun } from "../src/github/client.ts";

let nextId = 1;

function job(overrides: Partial<Job> = {}): Job {
  const started = overrides.started_at ?? "2026-07-01T10:00:00.000Z";
  return {
    id: nextId++,
    run_id: 1,
    run_attempt: 1,
    head_sha: "a".repeat(40),
    name: "test",
    conclusion: "success",
    started_at: started,
    completed_at: new Date(Date.parse(started) + 300_000).toISOString(), // 5 min
    labels: ["ubuntu-latest"],
    steps: [],
    ...overrides,
  };
}

function run(id: number, conclusion: string, startedAt: string, name = "CI"): WorkflowRun {
  return {
    id,
    name,
    head_sha: "a".repeat(40),
    head_branch: "main",
    run_number: id,
    status: "completed",
    conclusion,
    run_attempt: 1,
    run_started_at: startedAt,
    created_at: startedAt,
  };
}

function input(runs: WorkflowRun[], jobs: Record<number, Job[]>): WasteInput {
  return { repo: "acme/x", runs, jobsByRun: new Map(Object.entries(jobs).map(([k, v]) => [Number(k), v])) };
}

describe("cancelled work", () => {
  it("counts runner time thrown away by cancellation", () => {
    const findings = findWaste(
      input([run(1, "cancelled", "2026-07-01T10:00:00.000Z")], {
        1: [job({ run_id: 1, conclusion: "cancelled", name: "build" })],
      }),
    );
    const cancelled = findings.filter((f) => f.kind === "cancelled");
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]?.wastedSeconds, 300);
    assert.equal(cancelled[0]?.job, "build");
  });

  it("ignores jobs that were cancelled before running", () => {
    // Queued-then-cancelled jobs consumed no runner time, so they cost nothing.
    const zero = job({ run_id: 1, conclusion: "cancelled", name: "build" });
    zero.completed_at = zero.started_at;
    const findings = findWaste(input([run(1, "cancelled", "2026-07-01T10:00:00.000Z")], { 1: [zero] }));
    assert.deepEqual(findings.filter((f) => f.kind === "cancelled"), []);
  });

  it("aggregates repeat cancellations of the same job", () => {
    const findings = findWaste(
      input(
        [
          run(1, "cancelled", "2026-07-01T10:00:00.000Z"),
          run(2, "cancelled", "2026-07-02T10:00:00.000Z"),
        ],
        {
          1: [job({ run_id: 1, conclusion: "cancelled", name: "build" })],
          2: [job({ run_id: 2, conclusion: "cancelled", name: "build", started_at: "2026-07-02T10:00:00.000Z" })],
        },
      ),
    );
    const cancelled = findings.find((f) => f.kind === "cancelled");
    assert.equal(cancelled?.occurrences, 2);
    assert.equal(cancelled?.wastedSeconds, 600);
  });
});

describe("broken windows", () => {
  const consecutiveFailures = (count: number) => {
    const runs: WorkflowRun[] = [];
    const jobs: Record<number, Job[]> = {};
    for (let i = 0; i < count; i += 1) {
      const started = new Date(Date.parse("2026-07-01T10:00:00.000Z") + i * 3_600_000).toISOString();
      runs.push(run(i + 1, "failure", started));
      jobs[i + 1] = [job({ run_id: i + 1, conclusion: "failure", name: "flaky-gate", started_at: started })];
    }
    return input(runs, jobs);
  };

  it("flags a job left red for many runs in a row", () => {
    const findings = findWaste(consecutiveFailures(8));
    const broken = findings.find((f) => f.kind === "broken-window");
    assert.ok(broken, "8 consecutive failures should be a broken window");
    assert.equal(broken.occurrences, 8);
  });

  it("does not flag a short failure streak someone is probably fixing", () => {
    const findings = findWaste(consecutiveFailures(3));
    assert.deepEqual(findings.filter((f) => f.kind === "broken-window"), []);
  });

  it("resets the streak when the job passes", () => {
    const data = consecutiveFailures(8);
    // Insert a success midway; neither resulting streak reaches the threshold.
    const midRun = 4;
    data.jobsByRun.set(midRun, [
      job({ run_id: midRun, conclusion: "success", name: "flaky-gate", started_at: "2026-07-01T13:00:00.000Z" }),
    ]);
    const findings = findWaste(data);
    assert.deepEqual(findings.filter((f) => f.kind === "broken-window"), []);
  });

  it("says nothing about runs it never inspected", () => {
    // Successful runs are not fetched. Absence of job data must not be read as
    // absence of failure, or streaks would be computed from a partial picture.
    const runs = [run(1, "failure", "2026-07-01T10:00:00.000Z"), run(2, "success", "2026-07-01T11:00:00.000Z")];
    const findings = findWaste(
      input(runs, { 1: [job({ run_id: 1, conclusion: "failure", name: "x" })] }),
    );
    assert.deepEqual(findings.filter((f) => f.kind === "broken-window"), []);
  });
});

describe("ranking", () => {
  it("orders all waste by time, regardless of kind", () => {
    const findings = findWaste(
      input(
        [
          run(1, "cancelled", "2026-07-01T10:00:00.000Z"),
          ...Array.from({ length: 6 }, (_, i) =>
            run(i + 2, "failure", new Date(Date.parse("2026-07-02T10:00:00.000Z") + i * 3_600_000).toISOString()),
          ),
        ],
        {
          1: [job({ run_id: 1, conclusion: "cancelled", name: "long-build" })],
          ...Object.fromEntries(
            Array.from({ length: 6 }, (_, i) => {
              const started = new Date(Date.parse("2026-07-02T10:00:00.000Z") + i * 3_600_000).toISOString();
              const short = job({ run_id: i + 2, conclusion: "failure", name: "quick-gate", started_at: started });
              short.completed_at = new Date(Date.parse(started) + 10_000).toISOString();
              return [i + 2, [short]];
            }),
          ),
        },
      ),
    );
    assert.ok(findings.length >= 2);
    for (let i = 1; i < findings.length; i += 1) {
      assert.ok(findings[i - 1]!.wastedSeconds >= findings[i]!.wastedSeconds);
    }
  });
});
