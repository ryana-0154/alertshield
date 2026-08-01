# Local test harness

Fake infrastructure for building the analyzer without touching real GitHub: synthetic Actions data with deliberately planted flakes, a mock API that behaves like GitHub's, and a local Postgres.

Everything here is development tooling. None of it ships.

## Quick start

```bash
pnpm fixtures       # generate synthetic data + ground truth
pnpm mock-github    # serve it on http://localhost:8787
pnpm db:up          # Postgres on localhost:5433
cp .env.example .env
```

No `pnpm install` needed — the harness has **zero dependencies** and runs on Node's native TypeScript support (Node ≥22.18; you're on 24).

This project uses **pnpm**, not npm.

## What gets generated

Seven repos, ~3,000 workflow runs, ~6,900 jobs, all deterministic from seed `1337`. Each repo exists to test one claim:

| Repo | Tests |
|---|---|
| `acme/checkout-service` | Both flake causes, plus a genuine failure that must **not** be reported as flaky |
| `acme/web-app` | Windows/macOS runners — same minutes, very different dollars |
| `acme/platform-infra` | Self-hosted runners — real wasted minutes, **zero** derived cost |
| `acme/billing-worker` | Never reran, so Suspected tier only — no confirmed flakes exist |
| `acme/docs-site` | Healthy: must produce an empty report |
| `acme/legacy-api` | Flaky until ~45 days ago, clean since — exercises time windowing |
| `acme/dormant-tool` | No runs at all: must not count as an Active Repo for billing |

Timestamps anchor on today by default. Set `FIXTURE_NOW=2026-08-01T00:00:00.000Z` for byte-identical output across machines.

## Ground truth

`tools/fixtures/data/expected.json` lists every planted flake — repo, job, SHA, cause, failing step, wasted seconds — plus totals. Assert against it:

```bash
curl -s localhost:8787/_fixtures/expected | jq '.totals'
```

If your analyzer's output matches, it's correct by construction. If it finds flakes not in the manifest, it's over-reporting — which ADR-0004 treats as the more serious failure.

## Three traps the mock reproduces on purpose

These are real GitHub behaviours that break naive clients. The harness is built to make you hit them locally rather than in production.

**1. Reruns hide failures.** A rerun does *not* create a new workflow run — it adds an **attempt** to the existing one, and `/runs/:id/jobs` returns only the latest. Read it naively and every confirmed flake looks like a clean pass:

```bash
# the run's own conclusion says success…
curl -s localhost:8787/repos/acme/checkout-service/actions/runs/900080/attempts/1/jobs | jq '.jobs[] | {name, conclusion}'
# …but attempt 1 tells the truth
```

Use `/runs/:id/attempts/:n/jobs`, or `/runs/:id/jobs?filter=all`.

**2. Pagination is by `Link` header**, not a field in the body. There are 144 pages of runs for `checkout-service` at `per_page=5`. Ignore the header and you silently analyse only the first page.

**3. Log downloads 302-redirect** to a URL that carries no auth. Follow the redirect, and do **not** forward your Authorization header to the target.

Set `MOCK_RATE_LIMIT=1` to make every 20th request return 403 with `retry-after`, so backoff can be exercised.

## Log canaries

Every synthetic log contains two planted strings:

```
CANARY_SECRET_DO_NOT_PERSIST_a1b2c3d4
CANARY_PII_customer@example.invalid
```

ADR-0003 says logs are parsed in memory and never persisted. These are how you prove it. If either string ever appears in the database, a report, a cache, or a committed file, that guarantee has been broken:

```bash
podman exec alertshield-postgres psql -U alertshield -d alertshield \
  -c "\\dt" # then grep dumps for CANARY_ once tables exist
grep -r CANARY_ --exclude-dir=node_modules --exclude-dir=data .
```

The second command should only ever match `tools/fixtures/logs.ts` and this file.

## Database

`./scripts/db.sh {up|down|reset|psql|status}` — podman-driven, port 5433 to avoid colliding with a system Postgres.

**There is no schema yet, deliberately.** The data model is a design decision that hasn't been made, and guessing at one here would quietly pre-empt it. The script gives you an empty database and nothing more.

## Endpoints

GitHub-shaped:

```
GET /repos/:owner/:repo/actions/runs                      ?status= &branch= &per_page= &page=
GET /repos/:owner/:repo/actions/runs/:id
GET /repos/:owner/:repo/actions/runs/:id/jobs             ?filter=latest|all
GET /repos/:owner/:repo/actions/runs/:id/attempts/:n
GET /repos/:owner/:repo/actions/runs/:id/attempts/:n/jobs
GET /repos/:owner/:repo/actions/jobs/:id
GET /repos/:owner/:repo/actions/jobs/:id/logs             → 302
GET /rate_limit
```

Harness-only (no GitHub equivalent):

```
GET /_fixtures/repos        list generated repos
GET /_fixtures/expected     ground-truth manifest
GET /_logs/:job_id          log redirect target
```

## Adding scenarios

Edit `tools/fixtures/scenarios.ts` and re-run `pnpm fixtures`. Everything — runs, jobs, steps, logs, ground truth — is derived from that file. The four pattern kinds are `confirmed-flake`, `genuine-failure`, `suspected-flake`, and `healed-flake`; see the comments there for what each proves.
