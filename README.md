# AlertShield

**Finds the flaky CI failures quietly burning your GitHub Actions minutes — and proves what they cost.**

> ⚠️ **Status: pre-implementation.** No application code yet. The plan below supersedes the broader product brief in [`OVERVIEW.md`](./OVERVIEW.md); where the two disagree, this file and [`docs/adr/`](./docs/adr/) win.
>
> 📛 **The name is provisional.** "AlertShield" comes from an alerting product that is not being built. A rename is expected before public launch.

---

## The problem

CI fails. Someone hits rerun. It passes. Nobody investigates, and the same test fails again next week.

GitHub gives you no way to see this. The Actions UI shows you **one run at a time** — per-job durations, pass or fail, right there for free. What it never shows is the pattern *across* runs: which jobs fail and then pass at the same commit, how often, and how many runner-minutes that has cost you this month.

That gap is the whole product. Everything else follows from it.

## What it does

1. **Proves flakiness rather than guessing.** A *Confirmed Flake* is a job seen both passing and failing at the same commit SHA, with no code change between. Weaker patterns are reported separately as *Suspected*, clearly labelled. We would rather show you less than show you something wrong — see [ADR-0004](./docs/adr/0004-precision-over-recall-in-flake-classification.md).
2. **Says what broke.** Job logs are parsed to attribute each flake to **Infrastructure** (dead runner, network, registry, cache) or **Test Suite** (nondeterminism in your tests) — different problems with different owners.
3. **Never stores your logs.** Logs are streamed, classified in memory, and discarded. Only structured findings are persisted. This is an architectural commitment, not a policy page — see [ADR-0003](./docs/adr/0003-logs-parsed-in-memory-never-persisted.md).
4. **Counts the cost honestly.** Findings rank by **wasted minutes** — runner time consumed by attempts that failed to a confirmed flake, measured from job timestamps rather than estimated. Dollar figures are derived from published runner rates, with an override for self-hosted. No invented "engineering hours lost" multipliers.

**Read-only, always.** Nothing is quarantined, no workflows are edited, no PRs are opened. The install asks for read-only `actions` scope and that is all.

## Scope

Deliberately narrow, and staying that way until it works.

| | |
|---|---|
| **CI provider** | GitHub Actions only |
| **Granularity** | Job and step level; individual tests when JUnit artifacts already exist |
| **Delivery** | Web report first, Slack digest to follow |
| **Stack** | One TypeScript app, PostgreSQL, one worker process |

**Explicitly not in scope:** GitLab/Jenkins/CircleCI/Azure, cloud cost optimisation, alert correlation, test-impact analysis, and anything requiring write access. Several are good products. None are this one. See [ADR-0001](./docs/adr/0001-github-actions-flake-detection-as-the-wedge.md).

## Roadmap

**1 — Offline analyzer** *(first build)*
- [ ] Pull run/job history for ~100 well-known public repos — no auth beyond a token, no customers required
- [ ] Detect confirmed flakes; rank by wasted minutes
- [ ] Publish the findings as a public CI-flakiness benchmark

This validates the detection algorithm against real, messy data and tests whether flakes are common enough to sustain a business — before any product exists. It doubles as launch content.

**2 — Product**
- [ ] GitHub App: install, backfill, webhook ingestion
- [ ] Log-streaming classifier for flake causes
- [ ] The report page
- [ ] Billing

**3 — Retention & depth**
- [ ] Slack digest
- [ ] Test-level detection via existing JUnit artifacts
- [ ] Trend detection — jobs degrading over time

## Pricing

Free for public repos. Paid tiers around **$49 / $149 / $399 per month**, scaling on *active repos* — those with at least one workflow run in the trailing 30 days. Dormant and archived repos cost nothing, so org-wide installs carry no penalty.

## Repo layout

```
.
├── README.md              # You are here — the current plan
├── CONTEXT.md             # Domain glossary; the words this project uses
├── OVERVIEW.md            # Original product brief (superseded in scope)
├── CLAUDE.md              # Project instructions for Claude Code
└── docs/
    ├── adr/               # Architectural decisions and why
    └── agents/            # Agent tooling configuration
```

## Working in this repo

Read [`CONTEXT.md`](./CONTEXT.md) before writing anything user-facing — the vocabulary is deliberate. A *Workflow Run* is not a "build" or a "pipeline", and a bare "flake" is never a claim we make.

Issues live in GitHub Issues via the `gh` CLI, triaged with `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See [`CLAUDE.md`](./CLAUDE.md).
