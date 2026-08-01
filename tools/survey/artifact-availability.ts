/**
 * Do repos publish machine-readable test results?
 *
 * Test-level flake detection needs per-test pass/fail records. GitHub stores
 * none — the only routes are workflow artifacts (JUnit XML and friends) or
 * check-run annotations. This measures the artifact route, which is the cheap
 * one: `/actions/artifacts` is a single request per repository.
 *
 * Same measure-before-building move that ADR-0005 came from.
 *
 *   GITHUB_TOKEN=$(gh auth token) node tools/survey/artifact-availability.ts
 */

const TOKEN = process.env["GITHUB_TOKEN"];

/**
 * Artifact names that plausibly contain per-test results. Deliberately broad:
 * this is measuring an upper bound on availability, and a name match still has
 * to be confirmed by looking inside the archive.
 */
const TEST_RESULT = /junit|test[-_ ]?results?|test[-_ ]?report|surefire|failsafe|xunit|nunit|\btrx\b|allure|pytest|playwright[-_ ]?report|jest[-_ ]?results|cypress[-_ ]?results|\.xml\b/i;
const COVERAGE = /coverage|lcov|codecov|clover|jacoco/i;

const REPOS = [
  "vercel/next.js", "facebook/react", "microsoft/TypeScript", "nodejs/node",
  "denoland/deno", "vitejs/vite", "withastro/astro", "sveltejs/svelte",
  "vuejs/core", "angular/angular", "webpack/webpack", "babel/babel",
  "storybookjs/storybook", "nestjs/nest", "remix-run/react-router", "expressjs/express",
  "kubernetes/kubernetes", "grafana/grafana", "hashicorp/terraform", "rust-lang/rust",
  "golang/go", "prometheus/prometheus", "etcd-io/etcd", "cilium/cilium",
  "argoproj/argo-cd", "istio/istio", "helm/helm", "containerd/containerd",
  "pandas-dev/pandas", "numpy/numpy", "apache/airflow", "pytorch/pytorch",
  "huggingface/transformers", "scikit-learn/scikit-learn", "scipy/scipy", "pola-rs/polars",
  "elastic/elasticsearch", "ClickHouse/ClickHouse", "cockroachdb/cockroach", "redis/redis",
  "apache/kafka", "grpc/grpc", "envoyproxy/envoy", "openssl/openssl",
  "rails/rails", "django/django", "laravel/framework", "symfony/symfony",
  "spring-projects/spring-boot", "dotnet/runtime",
];

interface Artifact {
  name: string;
  size_in_bytes: number;
  expired: boolean;
  workflow_run?: { id: number };
}

interface Row {
  repo: string;
  artifacts: number;
  testResult: number;
  coverage: number;
  runsWithTests: number;
  verdict: "test results" | "coverage only" | "other artifacts" | "no artifacts" | "error";
  sample: string;
}

async function survey(repo: string): Promise<Row> {
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts?per_page=100`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "alertshield-survey",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
  });

  if (!res.ok) {
    return { repo, artifacts: 0, testResult: 0, coverage: 0, runsWithTests: 0, verdict: "error", sample: String(res.status) };
  }

  const body = (await res.json()) as { artifacts: Artifact[] };
  const live = body.artifacts.filter((a) => !a.expired);
  const tests = live.filter((a) => TEST_RESULT.test(a.name) && !COVERAGE.test(a.name));
  const coverage = live.filter((a) => COVERAGE.test(a.name));

  const runsWithTests = new Set(tests.map((a) => a.workflow_run?.id).filter(Boolean)).size;

  const verdict: Row["verdict"] =
    tests.length > 0 ? "test results"
    : coverage.length > 0 ? "coverage only"
    : live.length > 0 ? "other artifacts"
    : "no artifacts";

  return {
    repo,
    artifacts: live.length,
    testResult: tests.length,
    coverage: coverage.length,
    runsWithTests,
    verdict,
    sample: (tests[0] ?? live[0])?.name.slice(0, 38) ?? "—",
  };
}

const rows: Row[] = [];
for (const repo of REPOS) {
  rows.push(await survey(repo));
  process.stderr.write(".");
}
process.stderr.write("\n");

console.table(rows);

const ok = rows.filter((r) => r.verdict !== "error");
const withTests = ok.filter((r) => r.verdict === "test results");
const withAny = ok.filter((r) => r.artifacts > 0);

const pct = (n: number) => `${((n / ok.length) * 100).toFixed(0)}%`;

console.log(`
Repos surveyed:          ${ok.length}/${rows.length}
Publish ANY artifact:    ${withAny.length} (${pct(withAny.length)})
Publish TEST RESULTS:    ${withTests.length} (${pct(withTests.length)})   ← the number that matters
Coverage only:           ${ok.filter((r) => r.verdict === "coverage only").length}
No artifacts at all:     ${ok.filter((r) => r.verdict === "no artifacts").length}

Test-result artifact names seen:
${[...new Set(withTests.map((r) => r.sample))].slice(0, 15).map((s) => `  ${s}`).join("\n") || "  (none)"}
`);
