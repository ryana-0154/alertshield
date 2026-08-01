$ node tools/benchmark/generate-report.ts
# The State of CI Waste

**We analysed the last 245 GitHub Actions runs in 104 of the largest open-source repositories — 25,522 runs in total — and measured 1318 hours of provably wasted CI time.**

Not estimated. Every figure below comes from job start and finish timestamps in
GitHub's own API, and every finding names the repository, workflow and job it
came from so you can check it.

## What "wasted" means here

We only count work whose result was thrown away or ignored. Three categories,
all measurable without any access to the repositories beyond a public token:

| Category | Definition | Why it is waste |
| --- | --- | --- |
| **Confirmed flakes** | The same commit both passed and failed | The failure carried no information; the compute bought nothing |
| **Cancelled work** | A run superseded or stopped mid-flight | The output was discarded before anyone read it |
| **Broken windows** | A job red for 5+ consecutive runs | Nobody is acting on the result, so every further run is spend without a decision |

A deliberately excluded fourth category is ordinary failing builds. A test that
fails because the code is broken is CI doing its job, and counting it as waste
would inflate the number dishonestly.

## Headline numbers

| | |
| --- | --- |
| Repositories analysed | 104 |
| Workflow runs examined | 25,522 |
| **Total provably wasted time** | **1318 hours** |
| — from cancelled and ignored work | 1206 hours (91%) |
| — from confirmed flakes | 112 hours (9%) |
| Repos with at least one proven finding | 90 of 104 (87%) |
| Repos with nothing detectable at all | 12 (12%) |

Priced at GitHub's **Linux** rate that is about $633 — and that is a floor,
not an estimate: much of this ran on Windows and macOS runners, which bill at
2x and 10x Linux. Open-source repositories run free, so nobody paid it. The
figure matters because a private repository with the same pattern does pay,
every month.

## The finding that surprised us

Flaky tests get the attention, but they are **not** where the time goes.

Cancelled and ignored work accounts for **91%** of everything we
measured. Confirmed flakes account for 9%.

The reason is coverage. Proving a test is flaky requires the same commit to both
pass and fail, which in practice means somebody clicked "re-run". We measured
that separately: **only about 1.5% of workflow runs are ever rerun**, and in a
32-repo sample, 22 repos had no reruns at all. Flake detection found something in
56 of 104 repositories here (54%). Cancelled and ignored work found
something in 87 (84%).

If your CI dashboard only looks for flaky tests, it is looking at the smaller
problem in a minority of your repositories.

## Where the time actually goes

| Category | Findings | Time |
| --- | --- | --- |
| Cancelled work | 1691 | 820 hours |
| Broken windows | 192 | 386 hours |
| Confirmed flakes | 395 | 112 hours |

Among confirmed flakes, attributed cause:

| Cause | Occurrences | Time |
| --- | --- | --- |
| test-suite | 313 | 5332 min |
| unattributed | 15 | 987 min |
| infrastructure | 67 | 410 min |

Contrary to what we expected, infrastructure failures are the *minority*: 6% of confirmed-flake time against 79% from the test suites themselves. Where a flake can be proven, it is usually genuinely nondeterministic test code rather than a bad runner.

## The 15 largest single findings

| Repository | Job | Kind | Occurrences | Wasted |
| --- | --- | --- | --- | --- |
| `withastro/astro` | reply-labeled | Cancelled work | 3 | **4320 min** |
| `opencv/opencv` | Windows / Windows (x64, base, 5.x) | Broken windows | 60 | **4006 min** |
| `opencv/opencv` | Windows / Windows (x86, base, 5.x) | Broken windows | 43 | **3460 min** |
| `opencv/opencv` | Linux / Ubuntu (26.04, 5.x) | Broken windows | 9 | **1703 min** |
| `opencv/opencv` | CodeQL / Analyze | Broken windows | 19 | **988 min** |
| `netty/netty` | linux-riscv64-verify-native | Cancelled work | 9 | **890 min** |
| `supabase/supabase` | Analyze (javascript-typescript) | Cancelled work | 2 | **720 min** |
| `opencv/opencv` | Ubuntu2404-ARM64 / BuildAndTest | Broken windows | 8 | **655 min** |
| `rust-lang/rust` | PR - aarch64-gnu-llvm-21-1 | Broken windows | 10 | **599 min** |
| `opencv/opencv` | Linux / Ubuntu (22.04, 5.x) | Broken windows | 15 | **524 min** |
| `opencv/opencv` | macOS-ARM64 / BuildAndTest | Broken windows | 9 | **484 min** |
| `gohugoio/hugo` | test (1.26.x, windows-latest) | Broken windows | 20 | **479 min** |
| `opencv/opencv` | Linux / Ubuntu (20.04, 5.x) | Broken windows | 6 | **455 min** |
| `opencv/opencv` | Ubuntu2004-x64-CUDA / BuildAndTest | Broken windows | 19 | **428 min** |
| `opencv/opencv` | macOS-x64 / BuildAndTest | Broken windows | 8 | **370 min** |

## The largest confirmed flakes

| Repository | Job | Times | Cause | Wasted |
| --- | --- | --- | --- | --- |
| `opencv/opencv` | Windows / Windows (x86, base, 5.x) | 13 | test-suite | **1031 min** |
| `opencv/opencv` | Windows / Windows (x64, base, 5.x) | 12 | test-suite | **716 min** |
| `opencv/opencv` | Linux / Ubuntu (26.04, 5.x) | 17 | test-suite | **669 min** |
| `apache/flink` | Java 11 / E2E (group 2) | 1 | test-suite | **617 min** |
| `opencv/opencv` | Windows / Windows (x64, base, 4.x) | 3 | test-suite | **307 min** |
| `ClickHouse/ClickHouse` | Stress test (arm_tsan) | 1 | test-suite | **181 min** |
| `opencv/opencv` | macOS-ARM64 / BuildAndTest | 8 | test-suite | **156 min** |
| `ClickHouse/ClickHouse` | Integration tests (amd_asan_ubsan, db disk, ol | 1 | unattributed | **110 min** |
| `ClickHouse/ClickHouse` | Stateless tests (amd_llvm_coverage, AsyncInser | 1 | unattributed | **107 min** |
| `opencv/opencv` | Ubuntu2404-ARM64-Debug / BuildAndTest | 1 | unattributed | **105 min** |
| `opencv/opencv` | Windows / Windows (x86, base, 4.x) | 1 | test-suite | **97 min** |
| `apache/flink` | Java 21 / Test (module: tests) | 1 | test-suite | **90 min** |

## Per-repository results

| Repository | Runs | Flakes | Waste findings | Total wasted |
| --- | --- | --- | --- | --- |
| `opencv/opencv` | 250 | 136 | 60 | 21561 min |
| `ClickHouse/ClickHouse` | 250 | 16 | 127 | 7449 min |
| `rust-lang/rust` | 250 | 0 | 115 | 6207 min |
| `withastro/astro` | 250 | 1 | 7 | 4427 min |
| `protocolbuffers/protobuf` | 250 | 22 | 158 | 4277 min |
| `pytest-dev/pytest` | 250 | 5 | 53 | 3926 min |
| `webpack/webpack` | 250 | 0 | 48 | 2902 min |
| `apache/flink` | 250 | 16 | 14 | 2455 min |
| `netty/netty` | 250 | 6 | 33 | 2103 min |
| `netdata/netdata` | 250 | 0 | 98 | 1810 min |
| `rust-lang/cargo` | 250 | 10 | 29 | 1639 min |
| `denoland/deno` | 250 | 6 | 72 | 1255 min |
| `moby/moby` | 250 | 4 | 14 | 961 min |
| `php/php-src` | 250 | 0 | 11 | 913 min |
| `pola-rs/polars` | 250 | 1 | 23 | 880 min |
| `apache/airflow` | 250 | 0 | 32 | 875 min |
| `ruby/ruby` | 250 | 0 | 37 | 820 min |
| `supabase/supabase` | 250 | 0 | 4 | 721 min |
| `openssl/openssl` | 250 | 0 | 2 | 720 min |
| `scipy/scipy` | 250 | 0 | 35 | 719 min |
| `babel/babel` | 250 | 1 | 28 | 711 min |
| `nodejs/node` | 250 | 0 | 16 | 667 min |
| `apache/arrow` | 250 | 1 | 42 | 661 min |
| `jestjs/jest` | 250 | 0 | 51 | 660 min |
| `numpy/numpy` | 250 | 0 | 33 | 627 min |
| `sqlalchemy/sqlalchemy` | 250 | 0 | 22 | 604 min |
| `pandas-dev/pandas` | 250 | 0 | 22 | 600 min |
| `facebook/react` | 250 | 1 | 98 | 577 min |
| `envoyproxy/envoy` | 250 | 11 | 1 | 545 min |
| `gohugoio/hugo` | 250 | 2 | 3 | 537 min |
| `argoproj/argo-cd` | 250 | 0 | 18 | 454 min |
| `tokio-rs/tokio` | 250 | 1 | 75 | 431 min |
| `cilium/cilium` | 250 | 5 | 26 | 420 min |
| `pytorch/pytorch` | 250 | 0 | 2 | 362 min |
| `tailwindlabs/tailwindcss` | 250 | 4 | 25 | 342 min |
| `jekyll/jekyll` | 250 | 11 | 7 | 311 min |
| `containerd/containerd` | 250 | 15 | 3 | 275 min |
| `appwrite/appwrite` | 250 | 4 | 42 | 264 min |
| `laravel/framework` | 250 | 0 | 13 | 245 min |
| `redis/redis` | 250 | 4 | 18 | 221 min |
| `duckdb/duckdb` | 250 | 3 | 17 | 180 min |
| `sharkdp/bat` | 250 | 1 | 3 | 166 min |
| `BurntSushi/ripgrep` | 250 | 28 | 9 | 152 min |
| `docker/compose` | 250 | 8 | 31 | 149 min |
| `composer/composer` | 250 | 1 | 34 | 146 min |
| `google/guava` | 250 | 0 | 9 | 136 min |
| `symfony/symfony` | 250 | 2 | 12 | 132 min |
| `spring-projects/spring-boot` | 250 | 1 | 1 | 123 min |
| `rust-lang/rust-analyzer` | 250 | 1 | 12 | 120 min |
| `kubernetes/kubernetes` | 172 | 1 | 3 | 113 min |
| `ollama/ollama` | 250 | 9 | 1 | 112 min |
| `n8n-io/n8n` | 250 | 2 | 28 | 109 min |
| `pallets/flask` | 250 | 1 | 20 | 108 min |
| `vitejs/vite` | 250 | 9 | 5 | 108 min |
| `clap-rs/clap` | 250 | 0 | 15 | 86 min |
| `prettier/prettier` | 250 | 0 | 5 | 83 min |
| `istio/istio` | 250 | 0 | 3 | 82 min |
| `apache/kafka` | 250 | 5 | 3 | 66 min |
| `angular/angular` | 250 | 0 | 7 | 66 min |
| `starship/starship` | 250 | 4 | 3 | 64 min |
| `alacritty/alacritty` | 250 | 0 | 2 | 64 min |
| `django/django` | 250 | 1 | 5 | 61 min |
| `rclone/rclone` | 250 | 1 | 6 | 59 min |
| `pnpm/pnpm` | 250 | 2 | 2 | 54 min |
| `eslint/eslint` | 250 | 2 | 1 | 51 min |
| `vercel/next.js` | 250 | 6 | 5 | 42 min |
| `encode/django-rest-framework` | 250 | 2 | 8 | 40 min |
| `solidjs/solid` | 250 | 0 | 2 | 37 min |
| `discourse/discourse` | 250 | 2 | 13 | 34 min |
| `oven-sh/bun` | 250 | 0 | 4 | 28 min |
| `apache/lucene` | 250 | 0 | 2 | 25 min |
| `psf/requests` | 250 | 3 | 1 | 24 min |
| `tiangolo/fastapi` | 250 | 2 | 5 | 19 min |
| `traefik/traefik` | 250 | 3 | 0 | 16 min |
| `Homebrew/brew` | 250 | 0 | 3 | 15 min |
| `fastlane/fastlane` | 250 | 1 | 21 | 12 min |
| `psf/black` | 250 | 2 | 30 | 11 min |
| `vuejs/core` | 250 | 2 | 5 | 8 min |
| `expressjs/express` | 250 | 1 | 6 | 7 min |
| `helm/helm` | 250 | 1 | 1 | 7 min |
| `sveltejs/svelte` | 250 | 1 | 0 | 5 min |
| `storybookjs/storybook` | 250 | 0 | 5 | 3 min |
| `hashicorp/terraform` | 250 | 2 | 2 | 2 min |
| `scikit-learn/scikit-learn` | 250 | 0 | 4 | 1 min |
| `microsoft/TypeScript` | 250 | 0 | 2 | 1 min |
| `huggingface/transformers` | 250 | 0 | 1 | 0 min |
| `elastic/elasticsearch` | 250 | 0 | 4 | 0 min |
| `nuxt/nuxt` | 250 | 0 | 4 | 0 min |
| `electron/electron` | 250 | 0 | 1 | 0 min |
| `prometheus/prometheus` | 250 | 2 | 0 | 0 min |

## Concentration, and one outlier worth naming

Averages would mislead here. Waste is not spread evenly:

- **`opencv/opencv` alone accounts for 27% of everything measured.** A handful of repositories carry most of the total, and the median repository is far quieter than the mean implies.
- **8 findings hit a job timeout wall rather than an ordinary cancellation.** The largest, `withastro/astro`'s `reply-labeled`, burned 1440 min on each of 3 occurrences — jobs that hung until GitHub killed them. That is a different failure from a superseded run, and it is 5% of our headline number on its own.

Neither invalidates the finding, but any single number drawn from this sample
should be read with them in mind.

## Methodology, and what this does not show

**How it was measured.** For each repository we fetched the most recent
245 workflow runs via the public REST API. For every run that did not
succeed we fetched its jobs and read the start and finish timestamps. Confirmed
flakes come from comparing job outcomes across attempts of one run, or across
separate runs of the same commit. Cancelled and broken-window findings come from
job conclusions. Findings wasting under a minute in total are suppressed as noise.

**Sample windows differ.** A repository running 800 workflows a day covers a
different span in 245 runs than one running eight. Totals here are
per-sample, not per-unit-time, and should not be read as annual figures.

**This undercounts.** We never fetch jobs for successful runs, so waste inside a
green run is invisible. We cannot see queue time, redundant matrix legs, or
oversized runners. And flake detection is deliberately conservative: a flake
nobody reran cannot be proven and is not counted.

**Open source is not enterprise.** These repositories mostly use free runners
and have no merge queue pressure. Private repositories with required status
checks plausibly rerun more, which would raise the flake share. We have no way
to measure that from outside.

**Reproduce it.** The analyzer is open source. Point it at any public repository
with an unscoped token and you will get the same numbers.

