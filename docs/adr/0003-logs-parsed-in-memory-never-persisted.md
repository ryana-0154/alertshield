# Logs are parsed in memory and never persisted

Attributing a Flake Cause accurately requires reading job logs rather than inferring from which step failed. We stream logs, run classification over them in memory, and persist only structured output — matched pattern, cause category, confidence, and short redacted excerpts. Raw logs are never written to disk.

CI logs are the most sensitive surface we touch. GitHub masks registered secrets, but nothing masks a token a tool prints itself, a connection string in a stack trace, or PII in test fixtures. A one-person company storing other companies' logs carries liability out of all proportion to the benefit, and would undercut the low-trust-ask advantage that made a GitHub App the wedge in the first place.

## Consequences

Improving the classifier cannot be done by re-running it over stored history; it requires re-fetching logs, which GitHub retains for a limited window (90 days by default, often less). This makes iteration slower and is the accepted cost of the decision — the temptation to add a "short TTL log cache" while debugging misclassifications should be resisted, because it reintroduces exactly the liability this decision avoids.

"We never store your logs" is a deliberate, defensible sales position and should be stated publicly.
