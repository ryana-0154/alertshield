# AlertShield

Detects flaky CI failures in GitHub Actions and reports what they cost. This glossary fixes the language the project uses; it holds no implementation detail.

## Language

### Flakiness

**Confirmed Flake**:
A job observed both passing and failing at the same commit SHA with no intervening code change. The only class of finding presented as fact.
_Avoid_: flake, flaky test, flaky build

**Suspected Flake**:
An intermittent failure pattern consistent with flakiness but not proven at a single SHA. Always presented separately from Confirmed Flakes and never stated as fact.
_Avoid_: probable flake, likely flake

**Flake Cause**:
The attributed origin of a Confirmed Flake, either **Infrastructure** (runner, network, registry, cache) or **Test Suite** (nondeterminism in the tests themselves). Always an attribution, never a verdict.
_Avoid_: root cause, reason

**Quarantine**:
Suppressing a known-flaky job or test so it stops blocking. Reserved language — the product does not do this, and the term must not appear in output implying otherwise.

### GitHub concepts

**Workflow Run**:
One execution of a GitHub Actions workflow against a commit.
_Avoid_: build, pipeline, pipeline run, CI run

**Job**:
A unit of work within a Workflow Run, executing on a single runner. The level at which flakiness is currently detected.
_Avoid_: task, stage

**Run Attempt**:
One numbered try of a Workflow Run. A rerun creates a new attempt against the same commit, which is the primary evidence for a Confirmed Flake.
_Avoid_: retry, rerun (these name the human action, not the record)

### Value and billing

**Wasted Minutes**:
Runner time consumed by Run Attempts that failed due to a Confirmed Flake. The headline figure findings are ranked by, and exactly measurable.
_Avoid_: waste, lost time, burned minutes

**Active Repo**:
A repository with at least one Workflow Run in the trailing 30 days, counted at invoice time. The unit of billing.
_Avoid_: monitored repo, connected repo, service

**Backfill**:
The initial import of historical Workflow Runs when an installation is first connected, producing findings before any new run occurs.
_Avoid_: import, sync, historical scan
