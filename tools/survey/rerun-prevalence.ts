/**
 * How often does anybody actually rerun a workflow?
 *
 * Confirmed Flakes (ADR-0004) require a rerun at the same SHA. If reruns are
 * rare in the wild, the provable-core approach finds almost nothing and the
 * wedge needs rethinking. This measures that, cheaply: one request per repo.
 *
 *   GITHUB_TOKEN=$(gh auth token) node tools/survey/rerun-prevalence.ts
 */

const TOKEN = process.env["GITHUB_TOKEN"];
const SAMPLE = Number(process.env["SAMPLE"] ?? 100);

const REPOS = [
  // Large JS/TS monorepos with heavy CI
  "vercel/next.js",
  "facebook/react",
  "microsoft/TypeScript",
  "nodejs/node",
  "denoland/deno",
  "vitejs/vite",
  "withastro/astro",
  "sveltejs/svelte",
  "vuejs/core",
  "angular/angular",
  // Infrastructure / Go / Rust
  "kubernetes/kubernetes",
  "grafana/grafana",
  "hashicorp/terraform",
  "rust-lang/rust",
  "golang/go",
  "prometheus/prometheus",
  "etcd-io/etcd",
  "cilium/cilium",
  // Data / Python
  "pandas-dev/pandas",
  "numpy/numpy",
  "apache/airflow",
  "pytorch/pytorch",
  "huggingface/transformers",
  "scikit-learn/scikit-learn",
  // Databases / systems
  "elastic/elasticsearch",
  "ClickHouse/ClickHouse",
  "cockroachdb/cockroach",
  "redis/redis",
  // Web frameworks
  "rails/rails",
  "django/django",
  "laravel/framework",
  "symfony/symfony",
];

interface Row {
  repo: string;
  runs: number;
  reruns: number;
  rerunPct: number;
  failedRuns: number;
  failurePct: number;
  oldestRun: string;
  newestRun: string;
  error?: string;
}

async function survey(repo: string): Promise<Row> {
  const url = `https://api.github.com/repos/${repo}/actions/runs?per_page=${SAMPLE}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "alertshield-survey",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
  });

  if (!res.ok) {
    return {
      repo, runs: 0, reruns: 0, rerunPct: 0, failedRuns: 0, failurePct: 0,
      oldestRun: "", newestRun: "", error: `${res.status}`,
    };
  }

  const body = (await res.json()) as {
    workflow_runs: { run_attempt: number; conclusion: string; run_started_at: string }[];
  };
  const runs = body.workflow_runs;
  const reruns = runs.filter((r) => r.run_attempt > 1).length;
  const failed = runs.filter((r) => r.conclusion === "failure").length;
  const dates = runs.map((r) => r.run_started_at).sort();

  return {
    repo,
    runs: runs.length,
    reruns,
    rerunPct: runs.length ? Number(((reruns / runs.length) * 100).toFixed(1)) : 0,
    failedRuns: failed,
    failurePct: runs.length ? Number(((failed / runs.length) * 100).toFixed(1)) : 0,
    oldestRun: dates[0]?.slice(0, 10) ?? "",
    newestRun: dates[dates.length - 1]?.slice(0, 10) ?? "",
  };
}

const rows: Row[] = [];
for (const repo of REPOS) {
  rows.push(await survey(repo));
  process.stderr.write(".");
}
process.stderr.write("\n");

const ok = rows.filter((r) => !r.error && r.runs > 0);
const totalRuns = ok.reduce((n, r) => n + r.runs, 0);
const totalReruns = ok.reduce((n, r) => n + r.reruns, 0);
const totalFailed = ok.reduce((n, r) => n + r.failedRuns, 0);

console.table(rows.map(({ error, ...rest }) => (error ? { ...rest, repo: `${rest.repo} (${error})` } : rest)));
console.log(`
Repos surveyed:   ${ok.length}/${rows.length}
Runs sampled:     ${totalRuns}
Reruns:           ${totalReruns} (${((totalReruns / totalRuns) * 100).toFixed(2)}%)
Failed runs:      ${totalFailed} (${((totalFailed / totalRuns) * 100).toFixed(2)}%)
Repos with >0 reruns: ${ok.filter((r) => r.reruns > 0).length}/${ok.length}
`);
