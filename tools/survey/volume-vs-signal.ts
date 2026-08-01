/**
 * Does flake signal correlate with CI volume?
 *
 * ADR-0005 found only ~30% of repos have reruns and a follow-up found ~16%
 * publish test results — so we can prove something on roughly 40% of repos.
 * The open question is whether that gap is a sampling artifact: our ICP runs
 * heavy CI with merge queues and required checks, which forces reruns, while
 * low-volume repos simply never rerun anything.
 *
 * If signal rises with volume, the coverage gap does not affect the customers
 * we actually want. If it is flat, the gap is real and the product needs to
 * cover repos where nothing can be proven.
 *
 *   GITHUB_TOKEN=$(gh auth token) node tools/survey/volume-vs-signal.ts
 *
 * Three requests per repo. Observational and uncontrolled — this establishes
 * association, not causation, on a sample of large public repos.
 */

const TOKEN = process.env["GITHUB_TOKEN"];
const SAMPLE = 100;

const TEST_RESULT = /junit|test[-_ ]?results?|test[-_ ]?report|surefire|failsafe|xunit|nunit|\btrx\b|allure|pytest|playwright[-_ ]?report|jest[-_ ]?results|cypress[-_ ]?results/i;
const COVERAGE = /coverage|lcov|codecov|clover|jacoco/i;

const REPOS = [
  // deliberately spans very high to modest CI volume
  "kubernetes/kubernetes", "vercel/next.js", "rust-lang/rust", "nodejs/node",
  "microsoft/TypeScript", "facebook/react", "denoland/deno", "golang/go",
  "elastic/elasticsearch", "ClickHouse/ClickHouse", "pytorch/pytorch", "dotnet/runtime",
  "grafana/grafana", "hashicorp/terraform", "apache/airflow", "cockroachdb/cockroach",
  "envoyproxy/envoy", "istio/istio", "cilium/cilium", "containerd/containerd",
  "apache/kafka", "spring-projects/spring-boot", "rails/rails", "django/django",
  "laravel/framework", "symfony/symfony", "vitejs/vite", "vuejs/core",
  "sveltejs/svelte", "angular/angular", "withastro/astro", "webpack/webpack",
  "babel/babel", "storybookjs/storybook", "nestjs/nest", "expressjs/express",
  "pandas-dev/pandas", "numpy/numpy", "scipy/scipy", "scikit-learn/scikit-learn",
  "pola-rs/polars", "huggingface/transformers", "redis/redis", "grpc/grpc",
  "openssl/openssl", "prometheus/prometheus", "etcd-io/etcd", "argoproj/argo-cd",
  "helm/helm", "remix-run/react-router",
];

const headers = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "alertshield-survey",
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

async function api<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { headers });
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1_000;
    await new Promise((r) => setTimeout(r, Math.min(Math.max(reset - Date.now(), 5_000), 120_000)));
    return api<T>(url);
  }
  return res.ok ? ((await res.json()) as T) : null;
}

interface Row {
  repo: string;
  runsPerDay: number;
  reruns: number;
  rerunPct: number;
  failPct: number;
  testArtifacts: boolean;
  anySignal: boolean;
}

async function survey(repo: string): Promise<Row | null> {
  const runsBody = await api<{
    workflow_runs: { run_attempt: number; conclusion: string; run_started_at: string }[];
  }>(`https://api.github.com/repos/${repo}/actions/runs?per_page=${SAMPLE}`);
  if (!runsBody?.workflow_runs?.length) return null;

  const runs = runsBody.workflow_runs;
  const times = runs.map((r) => Date.parse(r.run_started_at)).sort((a, b) => a - b);
  const spanDays = Math.max((times[times.length - 1]! - times[0]!) / 86_400_000, 1 / 24);
  const runsPerDay = runs.length / spanDays;

  const reruns = runs.filter((r) => r.run_attempt > 1).length;
  const failed = runs.filter((r) => r.conclusion === "failure").length;

  const artifactsBody = await api<{ artifacts: { name: string; expired: boolean }[] }>(
    `https://api.github.com/repos/${repo}/actions/artifacts?per_page=100`,
  );
  const testArtifacts = (artifactsBody?.artifacts ?? []).some(
    (a) => !a.expired && TEST_RESULT.test(a.name) && !COVERAGE.test(a.name),
  );

  return {
    repo,
    runsPerDay: Number(runsPerDay.toFixed(1)),
    reruns,
    rerunPct: Number(((reruns / runs.length) * 100).toFixed(1)),
    failPct: Number(((failed / runs.length) * 100).toFixed(1)),
    testArtifacts,
    anySignal: reruns > 0 || testArtifacts,
  };
}

const rows: Row[] = [];
for (const repo of REPOS) {
  const row = await survey(repo);
  if (row) rows.push(row);
  process.stderr.write(".");
}
process.stderr.write("\n");

rows.sort((a, b) => b.runsPerDay - a.runsPerDay);

// --- Quartile analysis: the interpretable version ---------------------------
const quartile = Math.ceil(rows.length / 4);
const buckets = [
  { label: "Q1 highest volume", rows: rows.slice(0, quartile) },
  { label: "Q2", rows: rows.slice(quartile, quartile * 2) },
  { label: "Q3", rows: rows.slice(quartile * 2, quartile * 3) },
  { label: "Q4 lowest volume", rows: rows.slice(quartile * 3) },
];

const summary = buckets.map(({ label, rows: bucket }) => ({
  bucket: label,
  repos: bucket.length,
  medianRunsPerDay: Number(
    bucket.map((r) => r.runsPerDay).sort((a, b) => a - b)[Math.floor(bucket.length / 2)]?.toFixed(1) ?? 0,
  ),
  pctWithReruns: `${((bucket.filter((r) => r.reruns > 0).length / bucket.length) * 100).toFixed(0)}%`,
  pctWithTestArtifacts: `${((bucket.filter((r) => r.testArtifacts).length / bucket.length) * 100).toFixed(0)}%`,
  pctWithAnySignal: `${((bucket.filter((r) => r.anySignal).length / bucket.length) * 100).toFixed(0)}%`,
  meanRerunPct: Number((bucket.reduce((n, r) => n + r.rerunPct, 0) / bucket.length).toFixed(2)),
}));

// --- Correlation on log(volume) vs rerun rate -------------------------------
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

const r = pearson(rows.map((x) => Math.log10(x.runsPerDay + 1)), rows.map((x) => x.rerunPct));

console.table(rows);
console.table(summary);

const withSignal = rows.filter((x) => x.anySignal).length;
console.log(`
Repos:                         ${rows.length}
Any provable signal:           ${withSignal} (${((withSignal / rows.length) * 100).toFixed(0)}%)
Correlation, log(runs/day) vs rerun rate:  r = ${r.toFixed(3)}

Interpretation guide:
  r > 0.4   volume drives signal — the coverage gap is a sampling artifact,
            and our heavy-CI ICP will have data. Build the GitHub App.
  r ~ 0     signal is independent of volume — the gap is real, and repos with
            nothing provable need a product that still says something useful.
`);
