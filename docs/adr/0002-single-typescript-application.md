# Single TypeScript application over the OVERVIEW architecture

`OVERVIEW.md` proposes Go for ingestion, Python for ML, TimescaleDB, Kafka or Redpanda for streaming, Kubernetes, and both GraphQL and REST. We are instead building one TypeScript application — dashboard and webhook handling — plus plain PostgreSQL and a single long-running worker process for backfill and log streaming, self-hosted on existing Proxmox/VPS hardware.

That architecture is sized for a five-engineer team. Kafka decouples teams we do not have, two languages double context-switching for one person, and expected volume (order of a few million job records per year) is unremarkable for plain Postgres. Managed serverless was also rejected: execution time limits conflict directly with streaming large job logs.

## Consequences

TimescaleDB is adopted only if query latency actually becomes a problem, and a separate Go worker only if log-parsing throughput demands it — both are additive later rather than foundational now. Self-hosting means uptime is our problem, which is acceptable pre-revenue and should be revisited before the first paying customer depends on it.
