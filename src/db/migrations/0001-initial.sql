-- Initial schema.
--
-- ADR-0003: raw logs are never stored. The only log-derived text persisted is
-- `cause_excerpt`, a single redacted line. Nothing here holds a full log.

create table if not exists repos (
  id               bigserial primary key,
  full_name        text        not null unique,
  created_at       timestamptz not null default now(),
  last_ingested_at timestamptz
);

create table if not exists ingestions (
  id            bigserial   primary key,
  repo_id       bigint      not null references repos (id) on delete cascade,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  runs_analysed integer     not null default 0,
  api_requests  integer     not null default 0,
  error         text
);

create index if not exists ingestions_repo_started_idx on ingestions (repo_id, started_at desc);

create table if not exists confirmed_flakes (
  id              bigserial   primary key,
  repo_id         bigint      not null references repos (id) on delete cascade,
  workflow        text        not null,
  job             text        not null,
  head_sha        text        not null,
  run_id          bigint      not null,
  job_id          bigint      not null,
  -- 'rerun-attempt' | 'same-sha-runs' (ADR-0005)
  evidence        text        not null,
  runner          text        not null,
  runner_labels   text[]      not null default '{}',
  -- 'hosted' | 'self-hosted' | 'unknown'; unknown must not be shown as $0
  runner_class    text        not null,
  failed_attempts integer     not null,
  wasted_seconds  integer     not null,
  occurred_at     timestamptz not null,
  failing_step    text,
  -- 'infrastructure' | 'test-suite', always a likely cause, never a verdict
  cause            text,
  cause_pattern_id text,
  cause_confidence text,
  cause_excerpt    text,
  first_seen_at    timestamptz not null default now(),

  -- Re-ingesting an overlapping window must not duplicate findings.
  constraint confirmed_flakes_unique unique (repo_id, run_id, job_id)
);

create index if not exists confirmed_flakes_repo_occurred_idx
  on confirmed_flakes (repo_id, occurred_at desc);
create index if not exists confirmed_flakes_ranking_idx
  on confirmed_flakes (repo_id, wasted_seconds desc);

create table if not exists suspected_flakes (
  id           bigserial   primary key,
  repo_id      bigint      not null references repos (id) on delete cascade,
  workflow     text        not null,
  job          text        not null,
  failures     integer     not null,
  total_runs   integer     not null,
  failure_rate numeric(6, 4) not null,
  reason       text        not null,
  observed_at  timestamptz not null default now(),

  constraint suspected_flakes_unique unique (repo_id, workflow, job)
);

create index if not exists suspected_flakes_repo_idx on suspected_flakes (repo_id, failures desc);
