# Measure provable waste, not only flakes

Flake detection covers too few repositories to be a product on its own. We are widening the analyzer to measure **all provably wasted CI time** — cancelled and superseded runs, and jobs left failing for many consecutive runs — with confirmed flakes as the sharpest category inside that, not the whole of it.

## Why

ADR-0005 established that only ~1.5% of runs are ever rerun. The follow-up work tested two hypotheses that might have rescued flake-only detection, and both failed:

**Test-result artifacts would give us per-test data.** Surveying 50 large public repos: 86% publish some artifact, but only **16%** publish machine-readable test results. Test-level detection is real depth for a minority, not a fix for coverage.

**Heavy-CI repos rerun more, so our ICP would have signal.** The reasoning was that merge queues and required status checks force reruns. Measured across 50 repos, correlation between log(runs per day) and rerun rate is **r = 0.079** — no relationship. Worse, the busiest quartile (median 845 runs/day) had signal in only 23% of repos, against 54% in the third quartile.

Across the whole sample, **32% of repos have any provable flake signal**. For the other 68% the product would open on an empty page, and no amount of onboarding polish fixes having nothing to say.

## What we measure instead

Everything below is measured from job timestamps, not estimated, and none of it depends on anyone clicking rerun:

- **Cancelled and superseded runs** — work thrown away, usually when a push supersedes an in-flight run. Universal, and unambiguously wasted: the result was discarded.
- **Broken windows** — a job that has failed for many consecutive runs. Either nobody is reading it or nobody can fix it; every subsequent execution burns runner time for a signal already being ignored.
- **Confirmed flakes** — unchanged, and still the headline when present.

## Consequences

The product's claim widens from "we find your flaky tests" to "we show where your CI time goes and what is provably wasted." That is a less sharp story and closer to territory other tools occupy, which is a genuine cost — accepted because a sharp story told to an empty dashboard converts nobody.

ADR-0004 still governs: everything reported is measured or proven, and anything inferred stays clearly separated in the Suspected tier.

Cancelled-run waste in particular may be *correct* behaviour — cancelling superseded runs is good practice, and a high figure can mean concurrency groups are working, not that something is broken. Reporting it as pure waste without that nuance would be misleading, so it must be presented as "thrown-away compute", with the fix framed as reducing redundant triggers rather than disabling cancellation.
