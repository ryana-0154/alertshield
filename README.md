# AlertShield

**Shows where your GitHub Actions minutes go — and proves which of them were wasted.**

> ⚠️ **Status: working analyzer, not yet a product.** The engine, storage and report page run against live GitHub. There is no installable GitHub App, no billing, and nothing deployed. This file supersedes the broader brief in [`OVERVIEW.md`](./OVERVIEW.md); where they disagree, this and [`docs/adr/`](./docs/adr/) win.
>
> 📛 **The name is provisional.** "AlertShield" comes from an alerting product that is not being built. A rename is expected before public launch.

---

## The problem

CI fails. Someone hits rerun. It passes. Nobody investigates, and the same test fails again next week.

GitHub gives you no way to see this. The Actions UI shows you **one run at a time** — per-job durations, pass or fail, right there for free. What it never shows is the pattern *across* runs: which jobs waste time repeatedly, how often, and what that has cost you this month.

That gap is the whole product. Everything else follows from it.

## What it does

Four categories of **provably** wasted CI time, ranked by minutes:

| | |
|---|---|
| **Confirmed flakes** | The same commit both passed and failed |
| **Cancelled work** | Runs superseded mid-flight; the compute was discarded |
| **Broken windows** | Jobs red for many runs in a row that nobody acts on |
| **Suspected** | Intermittent failures with no proof — shown separately, never as fact |

Measured across 13 large public repos, flake detection alone found something in 7; adding the waste categories raised that to 11. The waste findings are also far larger — the biggest confirmed flake cost 34 minutes, while one broken window in `denoland/deno` cost 517.

### How

1. **Proves rather than guesses.** A *Confirmed Flake* is a job seen both passing and failing at the same commit SHA, with no code change between. Weaker patterns are reported separately as *Suspected*, clearly labelled. We would rather show you less than show you something wrong — see [ADR-0004](./docs/adr/0004-precision-over-recall-in-flake-classification.md).
2. **Says what broke.** Job logs are parsed to attribute each flake to **Infrastructure** (dead runner, network, registry, cache) or **Test Suite** (nondeterminism in your tests) — different problems with different owners.
3. **Never stores your logs.** Logs are streamed, classified in memory, and discarded. Only structured findings are persisted. This is an architectural commitment, not a policy page — see [ADR-0003](./docs/adr/0003-logs-parsed-in-memory-never-persisted.md).
4. **Counts the cost honestly.** Findings rank by **wasted minutes** — runner time consumed by attempts that failed to a confirmed flake, measured from job timestamps rather than estimated. Dollar figures are derived from published runner rates, with an override for self-hosted. No invented "engineering hours lost" multipliers.

**Read-only, always.** Nothing is quarantined, no workflows are edited, no PRs are opened. The install asks for read-only `actions` scope and that is all.

## Scope

Deliberately narrow, and staying that way until it works.

| | |
|---|---|
| **CI provider** | GitHub Actions only |
| **Granularity** | Job and step level; individual tests only where JUnit artifacts already exist |
| **Delivery** | Web report first, Slack digest to follow |
| **Stack** | One TypeScript app, PostgreSQL, one worker process |

**Explicitly not in scope:** GitLab/Jenkins/CircleCI/Azure, cloud cost optimisation, alert correlation, test-impact analysis, and anything requiring write access. Several are good products. None are this one. See [ADR-0001](./docs/adr/0001-github-actions-flake-detection-as-the-wedge.md).

## Roadmap

**1 — Offline analyzer** *(largely done)*
- [x] Detection engine: same-SHA proof, log-based cause attribution, wasted-minute ranking
- [x] Local test harness with synthetic fixtures and a mock GitHub API — see [`tools/`](./tools/README.md)
- [x] Validated against real repos, which found and fixed several false positives
- [x] Postgres persistence and a report page
- [ ] Scale the survey to ~100 repos and publish it as a public CI-flakiness benchmark

This validated the algorithm against real, messy data — and surfaced the finding in [ADR-0005](./docs/adr/0005-broaden-the-evidence-base-for-confirmed-flakes.md) that reruns are far rarer than assumed, which reshaped the detector.

**2 — Product**
- [ ] GitHub App: install and webhook ingestion *(needs an App registered on GitHub)*
- [ ] Scheduled re-ingestion
- [ ] Billing
- [ ] Slack digest — the retention mechanism a dashboard alone won't provide

**3 — Retention & depth**
- [ ] Test-level detection via existing JUnit artifacts — only ~16% of repos publish them, so this is depth for a minority
- [ ] Trend detection — jobs degrading over time

## Pricing

Free for public repos. Paid tiers around **$49 / $149 / $399 per month**, scaling on *active repos* — those with at least one workflow run in the trailing 30 days. Dormant and archived repos cost nothing, so org-wide installs carry no penalty.

## Running it

Requires Node ≥22.18 (TypeScript runs natively — no build step), **pnpm**, and podman or docker for Postgres.

```bash
pnpm install
pnpm db:up                                      # Postgres on :5433
cp .env.example .env

GITHUB_TOKEN=$(gh auth token) pnpm ingest vitejs/vite --max-runs 300
pnpm web                                        # report page on :3000
```

Public repos need no token scopes. `--max-runs` matters: large repos report 40,000 workflow runs, and uncapped pagination will exhaust the hourly rate limit on a single repository.

Without a database, print straight to the terminal:

```bash
GITHUB_TOKEN=$(gh auth token) pnpm analyze ClickHouse/ClickHouse --days 30
```

Develop against synthetic data instead of live GitHub:

```bash
pnpm fixtures && pnpm mock-github &
GITHUB_API_BASE_URL=http://localhost:8787 pnpm analyze
pnpm test                                       # 31 tests, no DB needed
DATABASE_URL=… pnpm test                        # 38, including persistence
```

## Repo layout

```
.
├── README.md              # You are here — the current plan
├── CONTEXT.md             # Domain glossary; the words this project uses
├── OVERVIEW.md            # Original product brief (superseded in scope)
├── CLAUDE.md              # Project instructions for Claude Code
├── src/
│   ├── github/            # API client: pagination, attempts, log streaming
│   ├── detect/            # Flake detection, cause attribution, waste analysis
│   ├── db/                # Schema, migrations, persistence
│   ├── web/               # Report page
│   ├── ingest.ts          # Analyse and store
│   └── report.ts          # Ranking and terminal rendering
├── tests/                 # Asserted against fixture ground truth
├── tools/                 # Test harness (fixtures + mock API) and surveys
└── docs/
    ├── adr/               # Architectural decisions and why
    └── agents/            # Agent tooling configuration
```

## Working in this repo

Read [`CONTEXT.md`](./CONTEXT.md) before writing anything user-facing — the vocabulary is deliberate. A *Workflow Run* is not a "build" or a "pipeline", and a bare "flake" is never a claim we make.

Issues live in GitHub Issues via the `gh` CLI, triaged with `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See [`CLAUDE.md`](./CLAUDE.md).
