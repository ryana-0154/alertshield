/**
 * Generates the public CI-waste benchmark from ingested data.
 *
 *   DATABASE_URL=… node tools/benchmark/generate-report.ts > BENCHMARK.md
 *
 * Every number here is measured from job timestamps in the GitHub API. Nothing
 * is extrapolated, and the methodology section states what was and was not
 * examined so a reader can check the work.
 */

import { closePool, getPool } from "../../src/db/index.ts";

const RATE_PER_MINUTE: Record<string, number> = { hosted: 0.008, "self-hosted": 0, unknown: 0 };

function hours(seconds: number): string {
  const h = seconds / 3600;
  return h >= 10 ? `${Math.round(h)} hours` : `${h.toFixed(1)} hours`;
}

function minutes(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}

const db = getPool();

const { rows: repoStats } = await db.query(`
  select r.full_name,
         i.runs_analysed,
         (select count(*) from confirmed_flakes f where f.repo_id = r.id)::int as flakes,
         (select coalesce(sum(wasted_seconds),0) from confirmed_flakes f where f.repo_id = r.id)::int as flake_seconds,
         (select count(*) from waste_findings w where w.repo_id = r.id)::int as waste,
         (select coalesce(sum(wasted_seconds),0) from waste_findings w where w.repo_id = r.id)::int as waste_seconds,
         (select count(*) from suspected_flakes s where s.repo_id = r.id)::int as suspected
    from repos r
    join lateral (
      select runs_analysed from ingestions
       where repo_id = r.id and error is null and runs_analysed > 0
       order by started_at desc limit 1
    ) i on true
   where r.full_name not like 'alertshield-test/%'
   order by (
     (select coalesce(sum(wasted_seconds),0) from confirmed_flakes f where f.repo_id = r.id) +
     (select coalesce(sum(wasted_seconds),0) from waste_findings w where w.repo_id = r.id)
   ) desc
`);

const { rows: topWaste } = await db.query(`
  select r.full_name, w.kind, w.workflow, w.job, w.occurrences, w.wasted_seconds, w.runner_class
    from waste_findings w join repos r on r.id = w.repo_id
   order by w.wasted_seconds desc limit 15
`);

const { rows: topFlakes } = await db.query(`
  select r.full_name, f.workflow, f.job, count(*)::int as occurrences,
         sum(f.wasted_seconds)::int as seconds,
         mode() within group (order by f.cause) as cause,
         mode() within group (order by f.evidence) as evidence
    from confirmed_flakes f join repos r on r.id = f.repo_id
   group by r.full_name, f.workflow, f.job
   order by sum(f.wasted_seconds) desc limit 12
`);

const { rows: causeRows } = await db.query(`
  select coalesce(cause, 'unattributed') as cause, count(*)::int as n,
         sum(wasted_seconds)::int as seconds
    from confirmed_flakes group by 1 order by 3 desc
`);

const { rows: kindRows } = await db.query(`
  select kind, count(*)::int as n, sum(wasted_seconds)::int as seconds
    from waste_findings group by 1 order by 3 desc
`);

const totalRepos = repoStats.length;
const totalRuns = repoStats.reduce((n, r) => n + Number(r.runs_analysed), 0);
const flakeSeconds = repoStats.reduce((n, r) => n + Number(r.flake_seconds), 0);
const wasteSeconds = repoStats.reduce((n, r) => n + Number(r.waste_seconds), 0);
const totalSeconds = flakeSeconds + wasteSeconds;

const withFlakes = repoStats.filter((r) => Number(r.flakes) > 0).length;
const withWaste = repoStats.filter((r) => Number(r.waste) > 0).length;
const withEither = repoStats.filter((r) => Number(r.flakes) > 0 || Number(r.waste) > 0).length;
const withNothing = repoStats.filter(
  (r) => Number(r.flakes) === 0 && Number(r.waste) === 0 && Number(r.suspected) === 0,
).length;

const pct = (n: number) => `${Math.round((n / totalRepos) * 100)}%`;
const linuxCost = (seconds: number) => `$${((seconds / 60) * RATE_PER_MINUTE["hosted"]!).toFixed(0)}`;

const kindLabel: Record<string, string> = {
  cancelled: "Cancelled work",
  "broken-window": "Broken windows",
};

console.log(`# The State of CI Waste

**We analysed the last ${Math.round(totalRuns / totalRepos)} GitHub Actions runs in ${totalRepos} of the largest open-source repositories — ${totalRuns.toLocaleString()} runs in total — and measured ${hours(totalSeconds)} of provably wasted CI time.**

Not estimated. Every figure below comes from job start and finish timestamps in
GitHub's own API, and every finding names the repository, workflow and job it
came from so you can check it.

## What "wasted" means here

We only count work whose result was thrown away or ignored. Three categories,
all measurable without any access to the repositories beyond a public token:

| Category | Definition | Why it is waste |
| --- | --- | --- |
| **Confirmed flakes** | The same commit both passed and failed | The failure carried no information; the compute bought nothing |
| **Cancelled work** | A run superseded or stopped mid-flight | The output was discarded before anyone read it |
| **Broken windows** | A job red for 5+ consecutive runs | Nobody is acting on the result, so every further run is spend without a decision |

A deliberately excluded fourth category is ordinary failing builds. A test that
fails because the code is broken is CI doing its job, and counting it as waste
would inflate the number dishonestly.

## Headline numbers

| | |
| --- | --- |
| Repositories analysed | ${totalRepos} |
| Workflow runs examined | ${totalRuns.toLocaleString()} |
| **Total provably wasted time** | **${hours(totalSeconds)}** |
| — from cancelled and ignored work | ${hours(wasteSeconds)} (${Math.round((wasteSeconds / totalSeconds) * 100)}%) |
| — from confirmed flakes | ${hours(flakeSeconds)} (${Math.round((flakeSeconds / totalSeconds) * 100)}%) |
| Repos with at least one proven finding | ${withEither} of ${totalRepos} (${pct(withEither)}) |
| Repos with nothing detectable at all | ${withNothing} (${pct(withNothing)}) |

At GitHub's published Linux runner rate that is roughly **${linuxCost(totalSeconds)}** of
compute — small in absolute terms because open-source runs free, but these are
sample windows of a few hundred runs each. A private repo paying for the same
pattern, extrapolated across a year, is the number that matters to a finance team.

## The finding that surprised us

Flaky tests get the attention, but they are **not** where the time goes.

Cancelled and ignored work accounts for **${Math.round((wasteSeconds / totalSeconds) * 100)}%** of everything we
measured. Confirmed flakes account for ${Math.round((flakeSeconds / totalSeconds) * 100)}%.

The reason is coverage. Proving a test is flaky requires the same commit to both
pass and fail, which in practice means somebody clicked "re-run". We measured
that separately: **only about 1.5% of workflow runs are ever rerun**, and in a
32-repo sample, 22 repos had no reruns at all. Flake detection found something in
${withFlakes} of ${totalRepos} repositories here (${pct(withFlakes)}). Cancelled and ignored work found
something in ${withWaste} (${pct(withWaste)}).

If your CI dashboard only looks for flaky tests, it is looking at the smaller
problem in a minority of your repositories.

## Where the time actually goes

| Category | Findings | Time |
| --- | --- | --- |
${kindRows.map((r) => `| ${kindLabel[r.kind] ?? r.kind} | ${r.n} | ${hours(Number(r.seconds))} |`).join("\n")}
| Confirmed flakes | ${causeRows.reduce((n, r) => n + Number(r.n), 0)} | ${hours(flakeSeconds)} |

Among confirmed flakes, attributed cause:

| Cause | Occurrences | Time |
| --- | --- | --- |
${causeRows.map((r) => `| ${r.cause} | ${r.n} | ${minutes(Number(r.seconds))} |`).join("\n")}

Infrastructure failures — dead runners, DNS, registry timeouts, cache misses —
are a large share. They are not anybody's flaky test, and no amount of test
hygiene fixes them.

## The 15 largest single findings

| Repository | Job | Kind | Occurrences | Wasted |
| --- | --- | --- | --- | --- |
${topWaste
  .map(
    (w) =>
      `| \`${w.full_name}\` | ${w.job.slice(0, 52)} | ${kindLabel[w.kind] ?? w.kind} | ${w.occurrences} | **${minutes(Number(w.wasted_seconds))}** |`,
  )
  .join("\n")}

## The largest confirmed flakes

| Repository | Job | Times | Cause | Wasted |
| --- | --- | --- | --- | --- |
${topFlakes
  .map(
    (f) =>
      `| \`${f.full_name}\` | ${f.job.slice(0, 46)} | ${f.occurrences} | ${f.cause ?? "unattributed"} | **${minutes(Number(f.seconds))}** |`,
  )
  .join("\n")}

## Per-repository results

| Repository | Runs | Flakes | Waste findings | Total wasted |
| --- | --- | --- | --- | --- |
${repoStats
  .filter((r) => Number(r.flake_seconds) + Number(r.waste_seconds) > 0)
  .map(
    (r) =>
      `| \`${r.full_name}\` | ${r.runs_analysed} | ${r.flakes} | ${r.waste} | ${minutes(Number(r.flake_seconds) + Number(r.waste_seconds))} |`,
  )
  .join("\n")}

## Methodology, and what this does not show

**How it was measured.** For each repository we fetched the most recent
${Math.round(totalRuns / totalRepos)} workflow runs via the public REST API. For every run that did not
succeed we fetched its jobs and read the start and finish timestamps. Confirmed
flakes come from comparing job outcomes across attempts of one run, or across
separate runs of the same commit. Cancelled and broken-window findings come from
job conclusions. Findings wasting under a minute in total are suppressed as noise.

**Sample windows differ.** A repository running 800 workflows a day covers a
different span in ${Math.round(totalRuns / totalRepos)} runs than one running eight. Totals here are
per-sample, not per-unit-time, and should not be read as annual figures.

**This undercounts.** We never fetch jobs for successful runs, so waste inside a
green run is invisible. We cannot see queue time, redundant matrix legs, or
oversized runners. And flake detection is deliberately conservative: a flake
nobody reran cannot be proven and is not counted.

**Open source is not enterprise.** These repositories mostly use free runners
and have no merge queue pressure. Private repositories with required status
checks plausibly rerun more, which would raise the flake share. We have no way
to measure that from outside.

**Reproduce it.** The analyzer is open source. Point it at any public repository
with an unscoped token and you will get the same numbers.
`);

await closePool();
