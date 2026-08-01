/**
 * Detector tests, asserted against the fixture ground truth.
 *
 * The manifest at tools/fixtures/data/expected.json lists every planted flake,
 * so correctness here is provable rather than eyeballed. Run:  pnpm test
 *
 * Spawns its own mock API on a dedicated port, so it does not collide with a
 * server you have running for development.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GitHubClient } from "../src/github/client.ts";
import { detectFlakes, priceRunner, type DetectionResult } from "../src/detect/index.ts";
import { CauseClassifier, causeFromFailingStep, redact } from "../src/detect/cause.ts";
import { buildReport } from "../src/report.ts";
import { LOG_CANARIES } from "../tools/fixtures/logs.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;
const BASE_URL = `http://localhost:${PORT}`;

interface Manifest {
  generatedFrom: { anchor: string };
  totals: {
    confirmedFlakes: number;
    wastedMinutes: number;
    derivedUsd: number;
    wastedMinutesByRepo: Record<string, number>;
  };
  repos: { full_name: string; confirmedFlakes: number; activeRepo: boolean }[];
  confirmedFlakes: { repo: string; job: string; cause: string }[];
}

let server: ChildProcess;
let manifest: Manifest;
let results: DetectionResult[];
let anchor: Date;

before(async () => {
  try {
    manifest = JSON.parse(
      await readFile(join(ROOT, "tools/fixtures/data/expected.json"), "utf8"),
    ) as Manifest;
  } catch {
    throw new Error("No fixtures found. Run `pnpm fixtures` first.");
  }
  anchor = new Date(manifest.generatedFrom.anchor);

  server = spawn("node", [join(ROOT, "tools/mock-github/server.ts")], {
    env: { ...process.env, MOCK_GITHUB_PORT: String(PORT) },
    stdio: "ignore",
  });

  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(`${BASE_URL}/rate_limit`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const client = new GitHubClient({ baseUrl: BASE_URL });
  const repos = (await (await fetch(`${BASE_URL}/_fixtures/repos`)).json()) as string[];
  results = [];
  for (const fullName of repos) {
    const [owner, repo] = fullName.split("/") as [string, string];
    results.push(await detectFlakes(client, owner, repo, { now: anchor }));
  }
});

after(() => {
  server?.kill();
});

describe("confirmed flakes match ground truth", () => {
  it("finds exactly the planted flakes, no more and no fewer", () => {
    const found = results.reduce((n, r) => n + r.confirmed.length, 0);
    assert.equal(found, manifest.totals.confirmedFlakes);
  });

  it("matches per-repo counts", () => {
    for (const expected of manifest.repos) {
      const actual = results.find((r) => r.repo === expected.full_name);
      assert.ok(actual, `no result for ${expected.full_name}`);
      assert.equal(
        actual.confirmed.length,
        expected.confirmedFlakes,
        `${expected.full_name}: expected ${expected.confirmedFlakes}, got ${actual.confirmed.length}`,
      );
    }
  });

  it("matches total wasted minutes", () => {
    const report = buildReport(results, anchor);
    assert.equal(report.totals.wastedMinutes, manifest.totals.wastedMinutes);
  });

  it("matches derived dollars", () => {
    const report = buildReport(results, anchor);
    assert.ok(
      Math.abs(report.totals.usd - manifest.totals.derivedUsd) < 0.05,
      `expected ~$${manifest.totals.derivedUsd}, got $${report.totals.usd}`,
    );
  });
});

describe("over-reporting is the serious failure (ADR-0004)", () => {
  it("never reports a job that failed on every attempt", () => {
    // acme/checkout-service `lint` is broken, not flaky: it fails on attempts
    // 1 and 2 alike. Calling it flaky would be exactly the credibility-losing
    // error ADR-0004 exists to prevent.
    const flagged = results
      .flatMap((r) => r.confirmed)
      .filter((f) => f.repo === "acme/checkout-service" && f.job === "lint");
    assert.deepEqual(flagged, []);
  });

  it("reports nothing at all for a healthy repo", () => {
    const docs = results.find((r) => r.repo === "acme/docs-site");
    assert.equal(docs?.confirmed.length, 0);
    assert.equal(docs?.suspected.length, 0);
  });

  it("keeps unproven findings out of the confirmed tier", () => {
    // Nobody reruns in billing-worker, so no same-SHA proof can exist.
    const billing = results.find((r) => r.repo === "acme/billing-worker");
    assert.equal(billing?.confirmed.length, 0);
    assert.ok((billing?.suspected.length ?? 0) > 0, "expected suspected findings");
  });
});

describe("cost derivation", () => {
  it("reports zero dollars but real minutes for self-hosted runners", () => {
    const report = buildReport(results, anchor);
    const group = report.groups.find((g) => g.repo === "acme/platform-infra");
    assert.ok(group, "expected a finding for platform-infra");
    assert.equal(group.usd, 0, "self-hosted runners must derive $0");
    assert.ok(group.wastedMinutes > 0, "wasted minutes are real regardless of cost");
  });

  it("prices macOS runners above Linux for comparable time", () => {
    const report = buildReport(results, anchor);
    const mac = report.groups.find((g) => g.job === "e2e-safari");
    const linux = report.groups.find((g) => g.job === "e2e-chrome");
    assert.ok(mac && linux);
    assert.ok(mac.usd > linux.usd, "macOS should cost more despite fewer wasted minutes");
    assert.ok(mac.wastedMinutes < linux.wastedMinutes);
  });
});

describe("cause attribution", () => {
  it("agrees with ground truth on the dominant cause per job", () => {
    const expectedByJob = new Map<string, string>();
    for (const flake of manifest.confirmedFlakes) {
      // Only assert jobs whose planted cause is unambiguous.
      const key = `${flake.repo} ${flake.job}`;
      const prior = expectedByJob.get(key);
      if (prior && prior !== flake.cause) expectedByJob.set(key, "mixed");
      else if (!prior) expectedByJob.set(key, flake.cause);
    }

    for (const result of results) {
      for (const flake of result.confirmed) {
        const expected = expectedByJob.get(`${flake.repo} ${flake.job}`);
        if (!expected || expected === "mixed") continue;
        assert.equal(
          flake.cause?.cause,
          expected,
          `${flake.repo} ${flake.job}: expected ${expected}, got ${flake.cause?.cause}`,
        );
      }
    }
  });

  it("attributes a cause to every confirmed flake", () => {
    for (const result of results) {
      for (const flake of result.confirmed) {
        assert.ok(flake.cause, `${flake.repo} ${flake.job} has no attributed cause`);
      }
    }
  });
});

describe("time windowing", () => {
  it("excludes flakes that were fixed before the window", async () => {
    // legacy-api was flaky until ~45 days ago and clean since.
    const client = new GitHubClient({ baseUrl: BASE_URL });
    const since = new Date(anchor.getTime() - 30 * 86_400_000);
    const recent = await detectFlakes(client, "acme", "legacy-api", { since, now: anchor });
    assert.equal(recent.confirmed.length, 0, "trailing 30 days should be clean");

    const allTime = results.find((r) => r.repo === "acme/legacy-api");
    assert.ok((allTime?.confirmed.length ?? 0) > 0, "all-time history should not be");
  });
});

describe("active repo (billing)", () => {
  it("agrees with the manifest on which repos are billable", () => {
    for (const expected of manifest.repos) {
      const actual = results.find((r) => r.repo === expected.full_name);
      assert.equal(
        actual?.activeRepo,
        expected.activeRepo,
        `${expected.full_name}: activeRepo mismatch`,
      );
    }
  });

  it("excludes a repo with no runs in the window", () => {
    const dormant = results.find((r) => r.repo === "acme/dormant-tool");
    assert.equal(dormant?.activeRepo, false);
  });
});

describe("logs are never persisted (ADR-0003)", () => {
  it("leaks no canary string into the report", () => {
    const serialised = JSON.stringify(buildReport(results, anchor));
    for (const canary of LOG_CANARIES) {
      assert.ok(
        !serialised.includes(canary),
        `canary ${canary} leaked into report output — ADR-0003 violated`,
      );
    }
  });

  it("redacts canaries directly", () => {
    for (const canary of LOG_CANARIES) {
      const out = redact(`some log line containing ${canary} inline`);
      assert.ok(!out.includes(canary), `redact() failed to mask ${canary}`);
    }
  });

  it("redacts tokens, emails and hosts", () => {
    assert.ok(!redact("Bearer ghp_abcdefghijklmnop1234").includes("ghp_"));
    assert.ok(!redact("mailto: someone@example.com").includes("someone@example.com"));
    assert.ok(!redact("GET https://internal.corp/secrets/x").includes("internal.corp"));
  });
});

describe("false positives found by surveying live repos", () => {
  it("does not read a filename containing 'assertionerror' as a failure", () => {
    // deno logs this on a PASSING test. The error word is part of the filename.
    const classifier = new CauseClassifier();
    classifier.feed("test node_compat::parallel::test-http-pipeline-assertionerror-finish.js ... ok (307ms)");
    assert.equal(classifier.verdict(), null);
  });

  it("ignores ANSI-coloured success lines", () => {
    const classifier = new CauseClassifier();
    classifier.feed("test foo::bar ... \x1b[0m\x1b[1m\x1b[32mok\x1b[0m \x1b[38;5;245m(12ms)\x1b[0m");
    assert.equal(classifier.verdict(), null);
  });

  it("attributes mid-name install steps to infrastructure", () => {
    // deno's "Pre-install rustup 1.28.2" was blamed on the test suite because
    // the old heuristic only matched at the start of the step name.
    assert.equal(causeFromFailingStep("Pre-install rustup 1.28.2")?.cause, "infrastructure");
    assert.equal(causeFromFailingStep("Restore cargo cache")?.cause, "infrastructure");
    assert.equal(causeFromFailingStep("Run tests")?.cause, "test-suite");
  });

  it("prices runner variants by prefix rather than exact label", () => {
    assert.equal(priceRunner(["windows-2022"]).class, "hosted");
    assert.equal(priceRunner(["ubuntu-slim"]).class, "hosted");
    assert.equal(priceRunner(["macos-14-large"]).usdPerMinute, 0.08);
  });

  it("separates 'self-hosted, genuinely free' from 'runner we cannot price'", () => {
    assert.equal(priceRunner(["self-hosted", "linux"]).class, "self-hosted");
    assert.equal(priceRunner(["some-custom-pool"]).class, "unknown");
  });

  it("suppresses zero-duration gate jobs", () => {
    // PR-title linters and `ci status` aggregators flip outcome at the same SHA
    // for reasons unrelated to code, and waste no runner time.
    const noise = {
      repo: "x/y",
      workflow: "pr",
      job: "lint title",
      headSha: "abc",
      runId: 1,
      jobId: 1,
      runner: "ubuntu-latest",
      runnerLabels: ["ubuntu-latest"],
      evidence: "same-sha-runs" as const,
      failedAttempts: 1,
      wastedSeconds: 3,
      occurredAt: "2026-01-01T00:00:00.000Z",
      failingStep: "Validate PR title",
      cause: null,
    };
    const report = buildReport(
      [
        {
          repo: "x/y",
          confirmed: [noise],
          suspected: [],
          runsAnalysed: 10,
          activeRepo: true,
          lastRunAt: null,
        },
      ],
      new Date("2026-01-02T00:00:00.000Z"),
    );
    assert.equal(report.groups.length, 0);
    assert.equal(report.totals.suppressedAsNoise, 1);
  });
});
