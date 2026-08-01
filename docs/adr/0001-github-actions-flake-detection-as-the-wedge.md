# GitHub Actions flake detection as the wedge

> **Status: partially superseded by [ADR-0006](./0006-measure-provable-waste-not-only-flakes.md).**
> The choice of GitHub Actions over cloud cost and alerting still holds, and the
> reasoning below is unchanged. What has changed is the scope *within* CI:
> flake detection proved too narrow to carry a product on its own, so the wedge
> is now provable CI waste, with flakes as one category inside it. Read this for
> why we are in CI at all; read ADR-0006 for what we measure there.

`OVERVIEW.md` scopes three products — Pipeline Intelligence, Cost Guardian, and Smart Alerting — and ranks cloud cost anomaly detection as the first thing to build. As a solo, revenue-seeking effort we can build exactly one, so we are building flaky-failure detection for GitHub Actions and nothing else.

Cost Guardian was rejected despite its clearer ROI story: AWS ships free native cost anomaly detection, the FinOps field is crowded, and asking strangers for billing-level cloud credentials is a hard first sale for an unknown one-person vendor. A GitHub App needs only read-only `actions` scope, installs from the Marketplace, and addresses pain engineers feel daily.

Within CI/CD we chose flakiness specifically because GitHub's own UI already shows per-job durations — a duration heatmap tells users what they can see for free. Nothing in GitHub reveals patterns *across* runs, so cross-run flake detection is the first genuinely new information we can offer.

## Consequences

Smart Alerting is deferred indefinitely, which leaves the product named after a capability it does not have — see the open naming question. The three-way CI/cost/alerting thesis in `OVERVIEW.md` remains the long-term ambition but is not being built toward yet.
