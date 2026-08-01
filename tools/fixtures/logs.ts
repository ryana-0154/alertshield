/**
 * Deterministic synthetic job logs.
 *
 * Rendered on demand rather than written to disk — partly to keep the fixture
 * tree small, and partly because ADR-0003 says we do not store logs. The
 * harness holds itself to the same rule.
 */

import type { FailingStep } from "./scenarios.ts";

/**
 * Canary strings planted in every log. Nothing derived from a log should ever
 * contain these: if one turns up in the database, in a report, or in a cached
 * artifact, the in-memory-only guarantee of ADR-0003 has been broken.
 */
export const LOG_CANARIES = [
  "CANARY_SECRET_DO_NOT_PERSIST_a1b2c3d4",
  "CANARY_PII_customer@example.invalid",
] as const;

const FAILURE_SIGNATURES: Record<FailingStep, string[]> = {
  "Set up job": [
    "Error: Failed to initialize container: timeout waiting for runner to become ready",
    "##[error]The runner has received a shutdown signal.",
  ],
  Checkout: [
    "fatal: unable to access 'https://github.com/acme/repo/': Could not resolve host: github.com",
    "##[error]The process '/usr/bin/git' failed with exit code 128",
  ],
  "Install dependencies": [
    "npm ERR! network request to https://registry.npmjs.org/lodash failed, reason: socket hang up",
    "npm ERR! network This is a problem related to network connectivity.",
    "##[error]Process completed with exit code 1.",
  ],
  "Run tests": [
    "  ● OrderProcessor › applies discount before tax",
    "    expect(received).toBe(expected)",
    "    Expected: 4200",
    "    Received: 4199",
    "      at OrderProcessor.test.ts:118:24",
    "Tests: 1 failed, 847 passed, 848 total",
    "##[error]Process completed with exit code 1.",
  ],
  "Upload coverage": [
    "Error uploading to coverage service: 503 Service Unavailable",
    "##[error]Process completed with exit code 1.",
  ],
};

export interface LogRenderInput {
  jobName: string;
  runnerLabel: string;
  steps: { name: string; conclusion: "success" | "failure" | "skipped" }[];
  startedAt: string;
  failingStep: FailingStep | null;
}

function ts(base: Date, offsetSeconds: number): string {
  return new Date(base.getTime() + offsetSeconds * 1_000).toISOString();
}

/** Render a full job log in roughly the shape GitHub serves. */
export function renderJobLog(input: LogRenderInput): string {
  const base = new Date(input.startedAt);
  const lines: string[] = [];
  let clock = 0;

  const emit = (text: string) => {
    lines.push(`${ts(base, clock)} ${text}`);
    clock += 1;
  };

  for (const step of input.steps) {
    emit(`##[group]${step.name}`);

    if (step.name === "Set up job") {
      emit(`Runner name: 'fake-runner-${input.runnerLabel}'`);
      emit(`Job name: '${input.jobName}'`);
      // Registered secrets arrive pre-masked from GitHub. Unregistered ones do not.
      emit("DEPLOY_TOKEN: ***");
      emit(`INTERNAL_ENDPOINT: https://internal.acme.invalid/${LOG_CANARIES[0]}`);
    }

    if (step.conclusion === "skipped") {
      lines.push(`##[debug]Step '${step.name}' skipped.`);
      emit("##[endgroup]");
      continue;
    }

    if (step.name === "Run tests") {
      emit(`Notifying ${LOG_CANARIES[1]} of test run start`);
      emit("PASS  src/orders/OrderProcessor.test.ts");
      emit("PASS  src/billing/Invoice.test.ts");
    }

    if (step.conclusion === "failure" && input.failingStep) {
      for (const line of FAILURE_SIGNATURES[input.failingStep]) emit(line);
    } else {
      emit(`Completed ${step.name}`);
    }

    emit("##[endgroup]");
  }

  lines.push(
    input.failingStep
      ? `${ts(base, clock)} ##[error]Job failed.`
      : `${ts(base, clock)} Job succeeded.`,
  );

  return lines.join("\n") + "\n";
}
