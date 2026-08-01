/**
 * How much flake signal actually exists in real repos?
 *
 * Measures three candidate signals so the detector can be aimed at whichever
 * one is real, rather than the one that was convenient to design:
 *
 *   A. RERUN ATTEMPTS  — attempt N fails, attempt N+1 passes, same run.
 *      What ADR-0004 currently relies on. Provable but rare.
 *
 *   B. SAME-SHA ACROSS RUNS — the same commit runs more than once (merge
 *      queue, schedule, re-triggered workflow) with differing outcomes.
 *      Equally provable; costs nothing extra to collect.
 *
 *   C. INTERMITTENT JOBS — a job that both fails and passes within the sample
 *      at DIFFERENT SHAs. Not proof, but the raw material for a Suspected tier.
 *
 *   GITHUB_TOKEN=$(gh auth token) node tools/survey/signal-yield.ts
 */

const TOKEN = process.env["GITHUB_TOKEN"];
const PAGES = Number(process.env["PAGES"] ?? 3);
const REPOS = (process.env["REPOS"] ?? [
  "etcd-io/etcd",
  "ClickHouse/ClickHouse",
  "vitejs/vite",
  "angular/angular",
  "huggingface/transformers",
  "denoland/deno",
  "microsoft/TypeScript",
  "laravel/framework",
  "django/django",
  "rust-lang/rust",
].join(",")).split(",");

const headers = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "alertshield-survey",
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

let requests = 0;

async function api<T>(url: string): Promise<T | null> {
  requests += 1;
  const res = await fetch(url, { headers });
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1_000;
    const wait = Math.max(reset - Date.now(), 5_000);
    process.stderr.write(`\n  rate limited, waiting ${Math.round(wait / 1000)}s\n`);
    await new Promise((r) => setTimeout(r, Math.min(wait, 120_000)));
    return api<T>(url);
  }
  return res.ok ? ((await res.json()) as T) : null;
}

interface Run {
  id: number;
  name: string;
  head_sha: string;
  conclusion: string;
  run_attempt: number;
  run_started_at: string;
  event: string;
}

interface Job {
  name: string;
  conclusion: string;
  started_at: string;
  completed_at: string;
  labels: string[];
}

interface Finding {
  repo: string;
  signal: "A-rerun" | "B-same-sha" | "C-intermittent";
  workflow: string;
  job: string;
  detail: string;
  wastedSeconds: number;
}

async function surveyRepo(repo: string): Promise<{ findings: Finding[]; runs: number }> {
  const runs: Run[] = [];
  for (let page = 1; page <= PAGES; page += 1) {
    const body = await api<{ workflow_runs: Run[] }>(
      `https://api.github.com/repos/${repo}/actions/runs?per_page=100&page=${page}`,
    );
    if (!body?.workflow_runs?.length) break;
    runs.push(...body.workflow_runs);
  }

  const findings: Finding[] = [];

  // --- Signal A: rerun attempts -------------------------------------------
  for (const run of runs.filter((r) => r.run_attempt > 1)) {
    const attempts = await Promise.all(
      Array.from({ length: Math.min(run.run_attempt, 4) }, (_, i) =>
        api<{ jobs: Job[] }>(
          `https://api.github.com/repos/${repo}/actions/runs/${run.id}/attempts/${i + 1}/jobs?per_page=100`,
        ),
      ),
    );

    const byJob = new Map<string, Job[]>();
    for (const attempt of attempts) {
      for (const job of attempt?.jobs ?? []) {
        byJob.set(job.name, [...(byJob.get(job.name) ?? []), job]);
      }
    }

    for (const [jobName, jobs] of byJob) {
      const failed = jobs.filter((j) => j.conclusion === "failure");
      const passed = jobs.filter((j) => j.conclusion === "success");
      if (!failed.length || !passed.length) continue;
      findings.push({
        repo,
        signal: "A-rerun",
        workflow: run.name,
        job: jobName,
        detail: `run ${run.id}, ${run.run_attempt} attempts`,
        wastedSeconds: failed.reduce(
          (n, j) => n + Math.max(0, (Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000),
          0,
        ),
      });
    }
  }

  // --- Signal B: same SHA, separate runs, differing outcomes ---------------
  const byWorkflowSha = new Map<string, Run[]>();
  for (const run of runs) {
    const key = `${run.name}|${run.head_sha}`;
    byWorkflowSha.set(key, [...(byWorkflowSha.get(key) ?? []), run]);
  }

  for (const [key, group] of byWorkflowSha) {
    if (group.length < 2) continue;
    const failed = group.filter((r) => r.conclusion === "failure");
    const passed = group.filter((r) => r.conclusion === "success");
    if (!failed.length || !passed.length) continue;
    findings.push({
      repo,
      signal: "B-same-sha",
      workflow: key.split("|")[0]!,
      job: "(run level)",
      detail: `${group.length} runs at ${key.split("|")[1]!.slice(0, 8)}, events: ${[...new Set(group.map((r) => r.event))].join("/")}`,
      wastedSeconds: 0,
    });
  }

  // --- Signal C: intermittent workflows (raw material for Suspected) -------
  const byWorkflow = new Map<string, { pass: number; fail: number }>();
  for (const run of runs) {
    const entry = byWorkflow.get(run.name) ?? { pass: 0, fail: 0 };
    if (run.conclusion === "success") entry.pass += 1;
    else if (run.conclusion === "failure") entry.fail += 1;
    byWorkflow.set(run.name, entry);
  }
  for (const [workflow, { pass, fail }] of byWorkflow) {
    const total = pass + fail;
    if (total < 10 || fail === 0 || fail / total > 0.3) continue;
    findings.push({
      repo,
      signal: "C-intermittent",
      workflow,
      job: "(workflow level)",
      detail: `${fail}/${total} failed (${((fail / total) * 100).toFixed(1)}%)`,
      wastedSeconds: 0,
    });
  }

  return { findings, runs: runs.length };
}

const all: Finding[] = [];
const perRepo: Record<string, { runs: number; A: number; B: number; C: number }> = {};

for (const repo of REPOS) {
  process.stderr.write(`${repo} `);
  const { findings, runs } = await surveyRepo(repo);
  all.push(...findings);
  perRepo[repo] = {
    runs,
    A: findings.filter((f) => f.signal === "A-rerun").length,
    B: findings.filter((f) => f.signal === "B-same-sha").length,
    C: findings.filter((f) => f.signal === "C-intermittent").length,
  };
  process.stderr.write(`→ A:${perRepo[repo]!.A} B:${perRepo[repo]!.B} C:${perRepo[repo]!.C}\n`);
}

console.table(perRepo);

const count = (s: Finding["signal"]) => all.filter((f) => f.signal === s).length;
console.log(`
Signal A (rerun attempts, provable):   ${count("A-rerun")} findings across ${Object.values(perRepo).filter((r) => r.A > 0).length}/${REPOS.length} repos
Signal B (same SHA, separate runs):    ${count("B-same-sha")} findings across ${Object.values(perRepo).filter((r) => r.B > 0).length}/${REPOS.length} repos
Signal C (intermittent, unprovable):   ${count("C-intermittent")} findings across ${Object.values(perRepo).filter((r) => r.C > 0).length}/${REPOS.length} repos
API requests: ${requests}
`);

console.log("Sample A findings (the only provable ones):");
for (const f of all.filter((f) => f.signal === "A-rerun").slice(0, 12)) {
  console.log(`  ${f.repo} · ${f.workflow} / ${f.job} — ${Math.round(f.wastedSeconds / 60)} min — ${f.detail}`);
}
console.log("\nSample B findings:");
for (const f of all.filter((f) => f.signal === "B-same-sha").slice(0, 8)) {
  console.log(`  ${f.repo} · ${f.workflow} — ${f.detail}`);
}
