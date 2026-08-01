# Precision over recall in flake classification

A Confirmed Flake requires proof: the same commit SHA observed both passing and failing, with no code change between. Weaker signals — intermittent failures, a commit that fails and later passes untouched — are reported only as Suspected Flakes, in a clearly separate tier, and never stated as fact.

The buyer is a skeptical engineer who will check our claims against runs they remember. Telling a team a test is flaky when their runner ran out of disk is the kind of error that discredits every other number we show. Broad statistical inference would produce a fuller dashboard sooner, and was rejected for that reason.

## Consequences

Recall suffers, and knowingly so: flakes that nobody bothered to rerun are invisible to the confirmed signal, because developers frequently push a new commit instead of hitting rerun. Early dashboards for low-traffic repos may look sparse, and that is preferable to looking wrong. Flake Cause attributions are likewise always presented as likely causes rather than verdicts.
