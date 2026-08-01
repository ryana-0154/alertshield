-- Provably wasted CI time that is not a flake (ADR-0006).
--
-- Flake detection covers only ~32% of repos. These categories exist on
-- essentially every repo and need no rerun to prove.

create table if not exists waste_findings (
  id             bigserial   primary key,
  repo_id        bigint      not null references repos (id) on delete cascade,
  -- 'cancelled' | 'broken-window'
  kind           text        not null,
  workflow       text        not null,
  job            text        not null,
  occurrences    integer     not null,
  wasted_seconds integer     not null,
  runner         text        not null,
  runner_labels  text[]      not null default '{}',
  runner_class   text        not null,
  detail         text        not null,
  last_seen      timestamptz not null,
  updated_at     timestamptz not null default now(),

  -- Re-ingest replaces the measurement for a given job rather than appending.
  constraint waste_findings_unique unique (repo_id, kind, workflow, job)
);

create index if not exists waste_findings_ranking_idx
  on waste_findings (repo_id, wasted_seconds desc);
