# Broaden the evidence base for Confirmed Flakes

ADR-0004 defines a Confirmed Flake as a job seen passing and failing at the same SHA, and in practice we only looked for that within **rerun attempts of a single run**. A survey of real repositories showed that is too narrow to build a product on, so we additionally treat **the same SHA running more than once as separate runs** as proof, and promote the Suspected tier to a first-class part of the report.

## The measurement

Sampling the most recent 100 workflow runs across 32 large public repositories (3,200 runs total):

- **1.5% of runs are ever rerun.** 22 of 32 repos had **zero** reruns.
- **5.8% of runs fail** — failures are roughly 4× more common than reruns.

Going deeper on 10 repos (300 runs each), counting distinct signals:

| Signal | Provable? | Findings | Repos with ≥1 |
| --- | --- | --- | --- |
| A — rerun attempts (what we had) | yes | 17 | 3 / 10 |
| B — same SHA across separate runs | yes | 5 | 3 / 10 |
| C — intermittent job failures | no | 16 | 9 / 10 |

Signal A alone leaves **70% of repos with a completely empty report**. That is fatal to the install-moment conversion the product is designed around: a new user lands on a page that says "no flakes found," and cannot distinguish a healthy pipeline from a broken product.

Where Signal A does fire, the findings are excellent — ClickHouse's `AST fuzzer` at 34 wasted minutes, vite's `Build&Test` at 8–9 — which is why the approach is being extended rather than abandoned.

## What changes

**Signal B is added to the confirmed tier.** When one commit runs more than once as separate runs (merge queues, re-triggered workflows, `pull_request` plus `pull_request_target`) and outcomes differ, that is the same proof as a rerun: identical code, different result. It costs no extra API calls, since the runs are already fetched.

**Signal C becomes a first-class Suspected section** rather than a footnote, because for most repos it is the only signal available. It remains clearly separated and never stated as fact — ADR-0004's precision rule is unchanged.

## Consequences

The confirmed/suspected distinction survives intact; only the evidence base for "confirmed" widens. Reports on most repos will still lead with Suspected findings, and the UI must make that honest rather than hiding it — a report that is mostly suspected must look different from one that is mostly proven.

The sample is public OSS, which likely **understates** corporate rerun rates: teams with required status checks and merge queues rerun far more often than maintainers who simply push a fix. This should be re-measured against real customer repos as soon as any exist, and this ADR revisited if the private-repo picture differs materially.

Test-level detection (parsing JUnit artifacts) remains the strongest untapped signal and is unaffected by rerun scarcity, since in-suite retries happen within a single run. It moves up in priority as a result of this finding.
