/**
 * A mock of the GitHub Actions REST API, served from generated fixtures.
 *
 * Run with:  npm run mock-github    (default http://localhost:8787)
 *
 * Point the analyzer at it with GITHUB_API_BASE_URL=http://localhost:8787.
 * Any Authorization header is accepted.
 *
 * This deliberately reproduces the three things that break naive clients
 * against real GitHub:
 *
 *   1. `/runs/:id/jobs` returns ONLY the latest attempt. Reruns hide failures.
 *      Use `/runs/:id/attempts/:n/jobs` to see what actually happened.
 *   2. Pagination is by Link header, not a cursor field in the body.
 *   3. Log downloads 302-redirect to a separate URL that carries no auth.
 *
 * Set MOCK_RATE_LIMIT=1 to make every 20th request return 403 with
 * x-ratelimit-remaining: 0, so backoff handling can be exercised.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderJobLog } from "../fixtures/logs.ts";
import type { FixtureJob, FixtureRun } from "../fixtures/generate.ts";
import type { FailingStep } from "../fixtures/scenarios.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "..", "fixtures", "data");
const PORT = Number(process.env["MOCK_GITHUB_PORT"] ?? 8787);
const SIMULATE_RATE_LIMIT = process.env["MOCK_RATE_LIMIT"] === "1";

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const runsByRepo = new Map<string, FixtureRun[]>();
const runsById = new Map<number, FixtureRun>();
const jobsById = new Map<number, FixtureJob>();

async function loadFixtures(): Promise<void> {
  let files: string[];
  try {
    files = (await readdir(join(DATA_DIR, "runs"))).filter((f) => f.endsWith(".json"));
  } catch {
    console.error(`No fixtures found in ${DATA_DIR}. Run: npm run fixtures`);
    process.exit(1);
  }

  for (const file of files) {
    const raw = await readFile(join(DATA_DIR, "runs", file), "utf8");
    const runs = JSON.parse(raw) as FixtureRun[];
    const fullName = file.replace(/\.json$/, "").replace("__", "/");
    runsByRepo.set(fullName, runs);

    for (const run of runs) {
      runsById.set(run.id, run);
      for (const attempt of run._attempts) {
        for (const job of attempt.jobs) jobsById.set(job.id, job);
      }
    }
  }

  console.log(
    `Loaded ${runsById.size} runs / ${jobsById.size} jobs across ${runsByRepo.size} repos.`,
  );
}

/** Strip internal fields GitHub would never return. */
function publicRun(run: FixtureRun): Omit<FixtureRun, "_attempts"> {
  const { _attempts, ...rest } = run;
  return rest;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-github-media-type": "github.v3",
    ...headers,
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res: ServerResponse, message = "Not Found"): void {
  json(res, 404, { message, documentation_url: "https://docs.github.com/rest" });
}

/** Paginate and emit a Link header the way GitHub does. */
function paginate<T>(
  items: T[],
  url: URL,
): { page: T[]; link: string | null; total: number } {
  const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 30), 100);
  const page = Math.max(Number(url.searchParams.get("page") ?? 1), 1);
  const lastPage = Math.max(Math.ceil(items.length / perPage), 1);
  const slice = items.slice((page - 1) * perPage, page * perPage);

  const build = (p: number) => {
    const next = new URL(url);
    next.searchParams.set("page", String(p));
    next.searchParams.set("per_page", String(perPage));
    return `<${next.toString()}>`;
  };

  const parts: string[] = [];
  if (page < lastPage) parts.push(`${build(page + 1)}; rel="next"`, `${build(lastPage)}; rel="last"`);
  if (page > 1) parts.push(`${build(1)}; rel="first"`, `${build(page - 1)}; rel="prev"`);

  return { page: slice, link: parts.length ? parts.join(", ") : null, total: items.length };
}

function failingStepOf(job: FixtureJob): FailingStep | null {
  const failed = job.steps.find((s) => s.conclusion === "failure");
  return failed ? (failed.name as FailingStep) : null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

let requestCount = 0;

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  requestCount += 1;

  if (SIMULATE_RATE_LIMIT && requestCount % 20 === 0) {
    return json(
      res,
      403,
      { message: "API rate limit exceeded", documentation_url: "https://docs.github.com/rest" },
      {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1_000) + 60),
        "retry-after": "2",
      },
    );
  }

  const rateHeaders = {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(Math.max(5_000 - requestCount, 0)),
  };

  // --- helper endpoints (not part of GitHub's API) -------------------------

  if (path === "/rate_limit") {
    return json(res, 200, {
      resources: { core: { limit: 5_000, remaining: 5_000 - requestCount, reset: 0 } },
    });
  }

  if (path === "/_fixtures/expected") {
    return json(res, 200, JSON.parse(await readFile(join(DATA_DIR, "expected.json"), "utf8")));
  }

  if (path === "/_fixtures/repos") {
    return json(res, 200, [...runsByRepo.keys()]);
  }

  // Redirect target for log downloads. GitHub serves these from blob storage
  // with no Authorization header, so clients must not forward credentials here.
  const rawLog = /^\/_logs\/(\d+)$/.exec(path);
  if (rawLog) {
    const job = jobsById.get(Number(rawLog[1]));
    if (!job) return notFound(res, "Log not found");
    const body = renderJobLog({
      jobName: job.name,
      runnerLabel: job.labels[0] ?? "unknown",
      steps: job.steps.map((s) => ({ name: s.name, conclusion: s.conclusion })),
      startedAt: job.started_at,
      failingStep: failingStepOf(job),
    });
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    return void res.end(body);
  }

  // --- GitHub-shaped endpoints --------------------------------------------

  // /repos/:owner/:repo/actions/...
  const repoRoute = /^\/repos\/([^/]+)\/([^/]+)\/actions\/(.+)$/.exec(path);
  if (!repoRoute) return notFound(res);

  const fullName = `${repoRoute[1]}/${repoRoute[2]}`;
  const rest = repoRoute[3]!;
  const repoRuns = runsByRepo.get(fullName);
  if (!repoRuns) return notFound(res, `Repository ${fullName} not found`);

  // GET /actions/runs
  if (rest === "runs") {
    let items = repoRuns;
    const status = url.searchParams.get("status");
    if (status) items = items.filter((r) => r.conclusion === status || r.status === status);
    const branch = url.searchParams.get("branch");
    if (branch) items = items.filter((r) => r.head_branch === branch);

    // GitHub returns newest first.
    const sorted = [...items].sort((a, b) => b.run_started_at.localeCompare(a.run_started_at));
    const { page, link, total } = paginate(sorted, url);
    return json(
      res,
      200,
      { total_count: total, workflow_runs: page.map(publicRun) },
      link ? { ...rateHeaders, link } : rateHeaders,
    );
  }

  // GET /actions/runs/:id
  const runOnly = /^runs\/(\d+)$/.exec(rest);
  if (runOnly) {
    const run = runsById.get(Number(runOnly[1]));
    if (!run || run.repository.full_name !== fullName) return notFound(res);
    return json(res, 200, publicRun(run), rateHeaders);
  }

  // GET /actions/runs/:id/jobs  — LATEST ATTEMPT ONLY (the trap)
  const runJobs = /^runs\/(\d+)\/jobs$/.exec(rest);
  if (runJobs) {
    const run = runsById.get(Number(runJobs[1]));
    if (!run) return notFound(res);
    const filter = url.searchParams.get("filter") ?? "latest";
    const jobs =
      filter === "all"
        ? run._attempts.flatMap((a) => a.jobs)
        : (run._attempts[run._attempts.length - 1]?.jobs ?? []);
    const { page, link, total } = paginate(jobs, url);
    return json(res, 200, { total_count: total, jobs: page }, link ? { ...rateHeaders, link } : rateHeaders);
  }

  // GET /actions/runs/:id/attempts/:n
  const attemptOnly = /^runs\/(\d+)\/attempts\/(\d+)$/.exec(rest);
  if (attemptOnly) {
    const run = runsById.get(Number(attemptOnly[1]));
    const attempt = run?._attempts.find((a) => a.run_attempt === Number(attemptOnly[2]));
    if (!run || !attempt) return notFound(res);
    return json(
      res,
      200,
      { ...publicRun(run), run_attempt: attempt.run_attempt, run_started_at: attempt.run_started_at, conclusion: attempt.conclusion },
      rateHeaders,
    );
  }

  // GET /actions/runs/:id/attempts/:n/jobs
  const attemptJobs = /^runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(rest);
  if (attemptJobs) {
    const run = runsById.get(Number(attemptJobs[1]));
    const attempt = run?._attempts.find((a) => a.run_attempt === Number(attemptJobs[2]));
    if (!run || !attempt) return notFound(res);
    const { page, link, total } = paginate(attempt.jobs, url);
    return json(res, 200, { total_count: total, jobs: page }, link ? { ...rateHeaders, link } : rateHeaders);
  }

  // GET /actions/jobs/:id
  const jobOnly = /^jobs\/(\d+)$/.exec(rest);
  if (jobOnly) {
    const job = jobsById.get(Number(jobOnly[1]));
    if (!job) return notFound(res);
    return json(res, 200, job, rateHeaders);
  }

  // GET /actions/jobs/:id/logs  → 302, as GitHub does
  const jobLogs = /^jobs\/(\d+)\/logs$/.exec(rest);
  if (jobLogs) {
    const job = jobsById.get(Number(jobLogs[1]));
    if (!job) return notFound(res);
    res.writeHead(302, { location: `http://localhost:${PORT}/_logs/${job.id}` });
    return void res.end();
  }

  return notFound(res);
}

await loadFixtures();

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error(err);
    json(res, 500, { message: String(err) });
  });
}).listen(PORT, () => {
  console.log(`Mock GitHub API listening on http://localhost:${PORT}`);
  console.log(`  repos:    GET /_fixtures/repos`);
  console.log(`  truth:    GET /_fixtures/expected`);
  console.log(`  example:  GET /repos/acme/checkout-service/actions/runs?per_page=5`);
  if (SIMULATE_RATE_LIMIT) console.log("  rate limiting: every 20th request returns 403");
});
