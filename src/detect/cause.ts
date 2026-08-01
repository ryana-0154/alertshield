/**
 * Flake Cause attribution from job logs.
 *
 * ADR-0003: logs are read in memory and discarded. Only the structured verdict
 * below survives — never the log text itself. The `excerpt` is passed through
 * a redactor first, and is the one field that could leak if we get it wrong.
 *
 * ADR-0004: this is always presented as a likely cause, never a verdict, so
 * every result carries a confidence and may be `null`.
 */

export type FlakeCause = "infrastructure" | "test-suite";

export interface CauseVerdict {
  cause: FlakeCause;
  /** Stable id of the matched signature, for aggregation and debugging. */
  patternId: string;
  confidence: "high" | "medium" | "low";
  /** Redacted single line. Safe to persist; still never the whole log. */
  excerpt: string;
}

interface Signature {
  id: string;
  cause: FlakeCause;
  confidence: CauseVerdict["confidence"];
  test: RegExp;
}

/**
 * Ordered by specificity — first match wins, so put narrow signatures above
 * broad ones. Extending this list is expected ongoing work.
 */
const SIGNATURES: Signature[] = [
  // --- infrastructure -----------------------------------------------------
  { id: "runner-shutdown", cause: "infrastructure", confidence: "high", test: /runner has received a shutdown signal/i },
  { id: "runner-init-timeout", cause: "infrastructure", confidence: "high", test: /failed to initialize container|timeout waiting for runner/i },
  { id: "dns-failure", cause: "infrastructure", confidence: "high", test: /could not resolve host|temporary failure in name resolution/i },
  { id: "registry-unavailable", cause: "infrastructure", confidence: "high", test: /registry\.npmjs\.org.*(socket hang up|ETIMEDOUT|ECONNRESET)|5\d\d Service Unavailable/i },
  { id: "network-generic", cause: "infrastructure", confidence: "medium", test: /\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|socket hang up|network (?:request|connectivity)/i },
  { id: "git-transport", cause: "infrastructure", confidence: "medium", test: /fatal: unable to access|the process '.*git' failed with exit code 128/i },
  { id: "disk-space", cause: "infrastructure", confidence: "high", test: /no space left on device|ENOSPC/i },
  { id: "docker-pull", cause: "infrastructure", confidence: "medium", test: /error pulling image|manifest unknown|toomanyrequests/i },

  // --- test suite ---------------------------------------------------------
  { id: "jest-assertion", cause: "test-suite", confidence: "high", test: /expect\(received\)|Expected:.*\n?.*Received:/i },
  { id: "test-summary-failed", cause: "test-suite", confidence: "high", test: /Tests?:\s*\d+ failed/i },
  { id: "assertion-generic", cause: "test-suite", confidence: "medium", test: /AssertionError|assert\.\w+ failed|expected .* (?:to equal|to be)/i },
  { id: "test-timeout", cause: "test-suite", confidence: "medium", test: /exceeded timeout of \d+\s*ms|test timed out after/i },
  { id: "unhandled-rejection", cause: "test-suite", confidence: "low", test: /UnhandledPromiseRejection|Unhandled rejection/i },
];

const REDACTIONS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+/g, "[token]"],
  [/\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|APIKEY|API_KEY|CANARY)[A-Za-z0-9_]*\b/gi, "[redacted]"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[hex]"],
  [/(https?:\/\/)[^\s/]+(\/\S*)?/g, "$1[host][path]"],
];

/** Strip anything credential- or identity-shaped from a line before persisting it. */
export function redact(line: string): string {
  let out = line;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.length > 240 ? `${out.slice(0, 240)}…` : out;
}

/**
 * Consumes log lines one at a time, retaining only the best match seen.
 *
 * Deliberately incremental: the caller streams a log through `feed` and the
 * classifier never holds more than a single line, so there is no buffer that
 * could be accidentally persisted.
 */
export class CauseClassifier {
  #best: { signature: Signature; line: string } | null = null;

  feed(line: string): void {
    if (this.#best?.signature.confidence === "high") return; // already conclusive
    for (const signature of SIGNATURES) {
      if (!signature.test.test(line)) continue;
      const better =
        !this.#best || rank(signature.confidence) > rank(this.#best.signature.confidence);
      if (better) this.#best = { signature, line };
      break;
    }
  }

  verdict(): CauseVerdict | null {
    if (!this.#best) return null;
    const { signature, line } = this.#best;
    return {
      cause: signature.cause,
      patternId: signature.id,
      confidence: signature.confidence,
      excerpt: redact(line.trim()),
    };
  }
}

function rank(confidence: CauseVerdict["confidence"]): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

/**
 * Fallback when no log signature matches: infer from which step failed.
 * Lower confidence by construction — it knows nothing about what went wrong.
 */
export function causeFromFailingStep(stepName: string | null): CauseVerdict | null {
  if (!stepName) return null;
  const infraSteps = /^(set up job|checkout|install|setup|post |upload |download )/i;
  return {
    cause: infraSteps.test(stepName) ? "infrastructure" : "test-suite",
    patternId: "step-heuristic",
    confidence: "low",
    excerpt: `failing step: ${redact(stepName)}`,
  };
}
