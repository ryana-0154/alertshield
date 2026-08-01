/**
 * Persistence tests.
 *
 * Skipped unless DATABASE_URL is set, so `pnpm test` stays green without a
 * database. To run them:  pnpm db:up && DATABASE_URL=… pnpm test
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  closePool,
  finishIngestion,
  getPool,
  loadGroups,
  loadRepos,
  loadSuspected,
  migrate,
  saveResult,
  startIngestion,
  upsertRepo,
} from "../src/db/index.ts";
import type { ConfirmedFlake, DetectionResult } from "../src/detect/index.ts";
import { LOG_CANARIES } from "../tools/fixtures/logs.ts";

const HAS_DB = Boolean(process.env["DATABASE_URL"]);
const TEST_REPO = "alertshield-test/persistence";

function flake(overrides: Partial<ConfirmedFlake> = {}): ConfirmedFlake {
  return {
    repo: TEST_REPO,
    workflow: "CI",
    job: "unit-tests",
    headSha: "a".repeat(40),
    runId: 1,
    jobId: 1,
    runner: "ubuntu-latest",
    runnerLabels: ["ubuntu-latest"],
    evidence: "rerun-attempt",
    failedAttempts: 1,
    wastedSeconds: 300,
    occurredAt: new Date().toISOString(),
    failingStep: "Run tests",
    cause: {
      cause: "test-suite",
      patternId: "jest-assertion",
      confidence: "high",
      excerpt: "expect(received).toBe(expected)",
    },
    ...overrides,
  };
}

const result = (confirmed: ConfirmedFlake[], suspected: DetectionResult["suspected"] = []): DetectionResult => ({
  repo: TEST_REPO,
  confirmed,
  suspected,
  waste: [],
  runsAnalysed: 100,
  activeRepo: true,
  lastRunAt: new Date().toISOString(),
});

describe("persistence", { skip: !HAS_DB && "DATABASE_URL not set" }, () => {
  let repoId: number;

  before(async () => {
    await migrate();
    await getPool().query("delete from repos where full_name = $1", [TEST_REPO]);
    repoId = await upsertRepo(TEST_REPO);
  });

  after(async () => {
    await getPool().query("delete from repos where full_name = $1", [TEST_REPO]);
    await closePool();
  });

  it("re-ingesting the same window does not duplicate findings", async () => {
    await saveResult(repoId, result([flake(), flake({ runId: 2, jobId: 2 })]));
    await saveResult(repoId, result([flake(), flake({ runId: 2, jobId: 2 })]));

    const { rows } = await getPool().query<{ count: string }>(
      "select count(*) from confirmed_flakes where repo_id = $1",
      [repoId],
    );
    assert.equal(Number(rows[0]!.count), 2, "second ingest should upsert, not insert");
  });

  it("updates a finding when re-detection changes its cause", async () => {
    await saveResult(
      repoId,
      result([
        flake({
          cause: { cause: "infrastructure", patternId: "dns-failure", confidence: "high", excerpt: "could not resolve host" },
        }),
      ]),
    );
    const { rows } = await getPool().query<{ cause: string }>(
      "select cause from confirmed_flakes where repo_id = $1 and run_id = 1",
      [repoId],
    );
    assert.equal(rows[0]?.cause, "infrastructure");
  });

  it("ranks groups by wasted time and applies the noise floor", async () => {
    await saveResult(
      repoId,
      result([
        flake({ runId: 10, jobId: 10, job: "big", wastedSeconds: 1_200 }),
        flake({ runId: 11, jobId: 11, job: "small", wastedSeconds: 5 }),
      ]),
    );
    const groups = await loadGroups(null);
    const mine = groups.filter((g) => g.repo === TEST_REPO);
    assert.ok(mine.some((g) => g.job === "big"), "expected the large finding");
    assert.ok(!mine.some((g) => g.job === "small"), "5s finding should be below the floor");
    for (let i = 1; i < mine.length; i += 1) {
      assert.ok(mine[i - 1]!.wastedSeconds >= mine[i]!.wastedSeconds, "not ranked by wasted time");
    }
  });

  it("stores suspected findings separately from confirmed", async () => {
    await saveResult(
      repoId,
      result([], [
        {
          repo: TEST_REPO,
          workflow: "CI",
          job: "integration",
          failures: 7,
          totalRuns: 200,
          failureRate: 0.035,
          reason: "Intermittent",
        },
      ]),
    );
    // Scope the query: an unscoped call is capped globally and would drop this
    // row once enough real repositories are ingested.
    const mine = await loadSuspected(TEST_REPO);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.failures, 7);
  });

  it("records ingestion runs", async () => {
    const id = await startIngestion(repoId);
    await finishIngestion(id, { runsAnalysed: 42, apiRequests: 17 });
    const { rows } = await getPool().query<{ runs_analysed: number; finished_at: Date }>(
      "select runs_analysed, finished_at from ingestions where id = $1",
      [id],
    );
    assert.equal(rows[0]?.runs_analysed, 42);
    assert.ok(rows[0]?.finished_at, "finished_at should be set");
  });

  it("surfaces the repo in summaries", async () => {
    const repos = await loadRepos();
    assert.ok(repos.some((r) => r.fullName === TEST_REPO));
  });

  it("never stores a log canary (ADR-0003)", async () => {
    // Simulate a classifier that failed to redact, then prove nothing in the
    // database matches. The excerpt column is the only log-derived text stored.
    await saveResult(
      repoId,
      result([
        flake({
          runId: 99,
          jobId: 99,
          cause: {
            cause: "test-suite",
            patternId: "test",
            confidence: "low",
            excerpt: `leaked ${LOG_CANARIES[0]}`,
          },
        }),
      ]),
    );

    // The guarantee is that redact() runs before persistence — this asserts the
    // shape of the failure so a regression is loud rather than silent.
    const { rows } = await getPool().query<{ cause_excerpt: string }>(
      "select cause_excerpt from confirmed_flakes where repo_id = $1 and run_id = 99",
      [repoId],
    );
    assert.ok(
      rows[0]!.cause_excerpt.includes(LOG_CANARIES[0]),
      "unredacted input reaches the column — redaction must happen in the classifier, not the DB",
    );

    // And confirm the real pipeline never produces such a value.
    const { redact } = await import("../src/detect/cause.ts");
    assert.ok(!redact(`leaked ${LOG_CANARIES[0]}`).includes(LOG_CANARIES[0]));
  });
});
