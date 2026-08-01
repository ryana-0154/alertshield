/**
 * Synthetic repositories and the flake patterns planted in each.
 *
 * Every scenario here exists to exercise one claim from the ADRs. The generator
 * turns these into GitHub-shaped API data plus a ground-truth manifest, so the
 * analyzer can be asserted against known-correct answers.
 *
 * Edit this file to add cases. Everything downstream is derived.
 */

/** Runner label, which sets the per-minute rate used for dollar derivation. */
export type RunnerLabel =
  | "ubuntu-latest"
  | "windows-latest"
  | "macos-latest"
  | "self-hosted";

/**
 * GitHub's published per-minute rates for hosted runners. Self-hosted bills
 * nothing per minute — the case a naive dollar calculation gets wrong.
 */
export const RUNNER_RATES_USD_PER_MINUTE: Record<RunnerLabel, number> = {
  "ubuntu-latest": 0.008,
  "windows-latest": 0.016,
  "macos-latest": 0.08,
  "self-hosted": 0,
};

/** Which step fails, which decides the Flake Cause attribution. */
export type FailingStep =
  | "Set up job"
  | "Checkout"
  | "Install dependencies"
  | "Run tests"
  | "Upload coverage";

export type FlakeCause = "infrastructure" | "test-suite";

/**
 * Steps that indicate infrastructure rather than the test suite. ADR-0003 has
 * us confirm this from logs, but the mapping is the ground truth we check against.
 */
export const CAUSE_BY_STEP: Record<FailingStep, FlakeCause> = {
  "Set up job": "infrastructure",
  Checkout: "infrastructure",
  "Install dependencies": "infrastructure",
  "Run tests": "test-suite",
  "Upload coverage": "infrastructure",
};

export type Pattern =
  /**
   * A Confirmed Flake: the job fails, is rerun at the same SHA, and passes.
   * This is the only pattern the analyzer may report as fact (ADR-0004).
   */
  | { kind: "confirmed-flake"; failingStep: FailingStep; occurrences: number }
  /**
   * A real failure that stays broken across every attempt at that SHA.
   * Reruns happen and still fail. Must never be reported as a flake.
   */
  | { kind: "genuine-failure"; failingStep: FailingStep; occurrences: number }
  /**
   * Intermittent failures on different SHAs that nobody ever reran. There is no
   * same-SHA proof, so this may only reach the Suspected tier.
   */
  | { kind: "suspected-flake"; failingStep: FailingStep; occurrences: number }
  /**
   * Was flaky, then fixed. Occurrences land outside the recent window, so a
   * trailing-30-day report should be clean while all-time history is not.
   */
  | { kind: "healed-flake"; failingStep: FailingStep; occurrences: number };

export interface JobSpec {
  name: string;
  runner: RunnerLabel;
  /** Typical successful duration, in seconds. Failures run shorter. */
  durationSeconds: number;
  patterns: Pattern[];
}

export interface WorkflowSpec {
  name: string;
  path: string;
  jobs: JobSpec[];
}

export interface RepoSpec {
  owner: string;
  name: string;
  /** Workflow runs generated per day across the history window. */
  runsPerDay: number;
  /** How many days of history to generate. */
  historyDays: number;
  workflows: WorkflowSpec[];
  /** Why this repo exists in the fixture set. */
  note: string;
}

export const HISTORY_DAYS = 90;

export const REPOS: RepoSpec[] = [
  {
    owner: "acme",
    name: "checkout-service",
    runsPerDay: 8,
    historyDays: HISTORY_DAYS,
    note: "Busy repo with both causes present, plus a genuine failure that must not be mistaken for a flake.",
    workflows: [
      {
        name: "CI",
        path: ".github/workflows/ci.yml",
        jobs: [
          {
            name: "unit-tests",
            runner: "ubuntu-latest",
            durationSeconds: 240,
            patterns: [{ kind: "confirmed-flake", failingStep: "Run tests", occurrences: 14 }],
          },
          {
            name: "integration-tests",
            runner: "ubuntu-latest",
            durationSeconds: 900,
            patterns: [
              { kind: "confirmed-flake", failingStep: "Run tests", occurrences: 6 },
              { kind: "confirmed-flake", failingStep: "Install dependencies", occurrences: 4 },
            ],
          },
          {
            name: "lint",
            runner: "ubuntu-latest",
            durationSeconds: 45,
            patterns: [{ kind: "genuine-failure", failingStep: "Run tests", occurrences: 5 }],
          },
        ],
      },
    ],
  },
  {
    owner: "acme",
    name: "web-app",
    runsPerDay: 12,
    historyDays: HISTORY_DAYS,
    note: "Expensive runners. Same minute count as Linux repos, far larger dollar figure.",
    workflows: [
      {
        name: "CI",
        path: ".github/workflows/ci.yml",
        jobs: [
          {
            name: "e2e-chrome",
            runner: "ubuntu-latest",
            durationSeconds: 1_200,
            patterns: [{ kind: "confirmed-flake", failingStep: "Run tests", occurrences: 22 }],
          },
          {
            name: "e2e-safari",
            runner: "macos-latest",
            durationSeconds: 1_500,
            patterns: [{ kind: "confirmed-flake", failingStep: "Run tests", occurrences: 9 }],
          },
          {
            name: "build-windows",
            runner: "windows-latest",
            durationSeconds: 600,
            patterns: [{ kind: "confirmed-flake", failingStep: "Install dependencies", occurrences: 7 }],
          },
        ],
      },
    ],
  },
  {
    owner: "acme",
    name: "platform-infra",
    runsPerDay: 4,
    historyDays: HISTORY_DAYS,
    note: "Self-hosted runners. Wasted minutes are real but derived cost is zero — the naive-dollars trap.",
    workflows: [
      {
        name: "Terraform",
        path: ".github/workflows/terraform.yml",
        jobs: [
          {
            name: "plan",
            runner: "self-hosted",
            durationSeconds: 300,
            patterns: [{ kind: "confirmed-flake", failingStep: "Checkout", occurrences: 11 }],
          },
        ],
      },
    ],
  },
  {
    owner: "acme",
    name: "billing-worker",
    runsPerDay: 3,
    historyDays: HISTORY_DAYS,
    note: "Nobody reruns here; they push empty commits instead. Suspected tier only, no confirmed flakes.",
    workflows: [
      {
        name: "CI",
        path: ".github/workflows/ci.yml",
        jobs: [
          {
            name: "tests",
            runner: "ubuntu-latest",
            durationSeconds: 420,
            patterns: [{ kind: "suspected-flake", failingStep: "Run tests", occurrences: 12 }],
          },
        ],
      },
    ],
  },
  {
    owner: "acme",
    name: "docs-site",
    runsPerDay: 2,
    historyDays: HISTORY_DAYS,
    note: "Healthy repo. Must produce an empty report — the sparse-dashboard case ADR-0004 accepts.",
    workflows: [
      {
        name: "CI",
        path: ".github/workflows/ci.yml",
        jobs: [
          { name: "build", runner: "ubuntu-latest", durationSeconds: 120, patterns: [] },
        ],
      },
    ],
  },
  {
    owner: "acme",
    name: "legacy-api",
    runsPerDay: 5,
    historyDays: HISTORY_DAYS,
    note: "Flaky until ~45 days ago, clean since. Trailing-30-day report is empty; all-time is not.",
    workflows: [
      {
        name: "CI",
        path: ".github/workflows/ci.yml",
        jobs: [
          {
            name: "tests",
            runner: "ubuntu-latest",
            durationSeconds: 540,
            patterns: [{ kind: "healed-flake", failingStep: "Run tests", occurrences: 18 }],
          },
        ],
      },
    ],
  },
  {
    owner: "acme",
    name: "dormant-tool",
    runsPerDay: 0,
    historyDays: HISTORY_DAYS,
    note: "No runs in the window. Must not count as an Active Repo for billing.",
    workflows: [
      {
        name: "CI",
        path: ".github/workflows/ci.yml",
        jobs: [
          { name: "build", runner: "ubuntu-latest", durationSeconds: 60, patterns: [] },
        ],
      },
    ],
  },
];

/** Standard step sequence for a generated job. */
export const STEP_SEQUENCE: FailingStep[] = [
  "Set up job",
  "Checkout",
  "Install dependencies",
  "Run tests",
  "Upload coverage",
];
