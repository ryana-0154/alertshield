# AlertShield

**CI/CD pipeline intelligence & cloud cost optimizer for mid-market engineering teams.**

> ⚠️ **Status: pre-implementation.** This repo currently contains planning and agent configuration only — there is no application code yet. See [Roadmap](#roadmap) for what's being built first.

---

## The problem

DevOps teams pay for three separate problems and solve none of them well:

| Pain | Reality |
| --- | --- |
| **Slow pipelines** | 45–90 minute CI runs push engineers to bypass checks or rerun until green |
| **Runaway observability spend** | Monitoring bills rivalling the cloud bill itself |
| **Alert fatigue** | Channels muted within weeks because everything is a false positive |
| **Tool sprawl** | K8s, Terraform, Prometheus, Grafana, Datadog, PagerDuty, Vault, ArgoCD — none integrated |
| **Cloud waste** | Per the CNCF survey, 49% of orgs spend *more* after migrating to Kubernetes |

Existing tools treat these in isolation. Datadog monitors but doesn't optimize cost. GitHub Actions caches but won't skip irrelevant tests. PagerDuty routes alerts but doesn't reduce them. **No product connects CI/CD performance → cloud cost → alert health in one view**, and enterprise suites price out teams of 50–1,000 people.

## What AlertShield does

Three capabilities behind one dashboard:

1. **Pipeline Intelligence** — profiles CI/CD runs (GitHub Actions, GitLab CI, Jenkins, CircleCI, Azure DevOps) to find bottlenecks, and recommends what to parallelize, cache, or skip based on diff analysis. Integrates with existing tooling; no migration.
2. **Cost Guardian** — reads cloud billing APIs (AWS Cost Explorer, GCP Billing, Azure Cost Management) to flag over-provisioned instances, idle load balancers, unattached volumes, and orphaned snapshots. Predicts monthly spend and detects anomalies in hours, with cost-per-service attribution.
3. **Smart Alerting Engine** — ingests alerts from any source, correlates related signals into single incidents, and learns per-service baselines so it pages only on genuine deviation.

### Architecture (planned)

```
CI/CD Providers ──┐
Cloud Billing ────┼──▶  ALERTSHIELD ENGINE  ──▶  Dashboard & Notifications
Monitoring ───────┘     • Anomaly detection      • Cost dashboards
                        • Cost attribution       • CI/CD heat maps
                        • Alert correlation      • Recommendations
                        • Pipeline profiling     • Slack / Teams / PagerDuty
```

- **Ingestion** — lightweight Go agent polling cloud APIs every 5 min; webhooks for CI/CD events
- **Processing** — Kafka/Redpanda streaming → stateless normalization and anomaly detection → materialized views
- **Storage** — hot tier in PostgreSQL/TimescaleDB (90 days) → cold tier in S3/Iceberg for retention
- **API** — GraphQL for the frontend, REST for third-party integrations

All integrations are **read-only by design** — AlertShield never writes to production systems.

### Intended stack

Go (ingestion) · Python (ML/analytics) · TimescaleDB + PostgreSQL · React + TypeScript · scikit-learn + Prophet · Kubernetes-native

## Roadmap

**MVP — Cost Guardian core**
- [ ] AWS Cost Explorer connector
- [ ] Baseline anomaly detection (threshold + z-score on daily spend)
- [ ] Dashboard: daily spend, week-over-week delta, top cost drivers
- [ ] Slack digest — *"Your AWS bill increased $X today — top 3 offenders"*

**MVP — CI/CD bottleneck analyzer**
- [ ] GitHub Actions connector (webhook-based)
- [ ] Per-job duration, queue time, failure rate from workflow runs
- [ ] Pipeline timeline heatmap by repo/job
- [ ] First-pass recommendation engine

**Beyond MVP**
- [ ] GCP and Azure billing APIs
- [ ] Alert correlation engine
- [ ] Cost-per-service attribution via resource tagging
- [ ] Test-impact analysis from git diff patterns — the key differentiator

**Target outcomes:** surface ≥$1,000/month of detectable waste in week one · cover >80% of a typical monorepo's CI jobs · signup → first actionable insight in under 10 minutes.

## Repo layout

```
.
├── OVERVIEW.md            # Full product brief — problem, market, pricing, GTM
├── README.md              # You are here
├── CLAUDE.md              # Project instructions for Claude Code
└── docs/
    └── agents/            # Configuration consumed by the engineering skills
        ├── issue-tracker.md   # GitHub Issues via the `gh` CLI
        ├── triage-labels.md   # The five canonical triage labels
        └── domain.md          # Single-context domain-doc rules
```

## Working in this repo

Issues are tracked in **GitHub Issues** and managed through the `gh` CLI. Triage uses five labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

Agent tooling reads its configuration from `docs/agents/` — see [`CLAUDE.md`](./CLAUDE.md) for the pointers. `CONTEXT.md` and `docs/adr/` don't exist yet; they get created as domain terms and architectural decisions are actually settled.

## Further reading

[`OVERVIEW.md`](./OVERVIEW.md) holds the full brief: target audience, competitive landscape, pricing tiers, and go-to-market strategy.
