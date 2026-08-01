/**
 * Minimal GitHub Actions REST client.
 *
 * Handles the three things that silently corrupt results if ignored:
 * Link-header pagination, per-attempt job retrieval, and log downloads that
 * 302-redirect to a host which must NOT receive our Authorization header.
 */

export interface WorkflowRun {
  id: number;
  name: string;
  head_sha: string;
  head_branch: string;
  run_number: number;
  status: string;
  conclusion: "success" | "failure" | string;
  run_attempt: number;
  run_started_at: string;
  created_at: string;
  repository?: { full_name: string };
}

export interface JobStep {
  name: string;
  conclusion: "success" | "failure" | "skipped" | string;
  number: number;
  started_at: string;
  completed_at: string;
}

export interface Job {
  id: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  name: string;
  conclusion: "success" | "failure" | string;
  started_at: string;
  completed_at: string;
  labels: string[];
  steps: JobStep[];
}

export interface ClientOptions {
  baseUrl?: string;
  token?: string;
  /** Retries on secondary rate limits before giving up. */
  maxRetries?: number;
}

export class GitHubClient {
  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #maxRetries: number;
  #requests = 0;

  constructor(options: ClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? process.env["GITHUB_API_BASE_URL"] ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
    this.#token = options.token ?? process.env["GITHUB_TOKEN"];
    this.#maxRetries = options.maxRetries ?? 3;
  }

  get requestCount(): number {
    return this.#requests;
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "alertshield",
    };
    if (this.#token) headers["authorization"] = `Bearer ${this.#token}`;
    return headers;
  }

  async #request(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      this.#requests += 1;
      const res = await fetch(url, { headers: this.#headers() });

      const exhausted = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
      if (!exhausted || attempt >= this.#maxRetries) return res;

      // Honour retry-after, else fall back to the reset timestamp.
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0);
      const waitMs = retryAfter
        ? retryAfter * 1_000
        : Math.max(reset * 1_000 - Date.now(), 1_000);
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 60_000)));
    }
  }

  /** Follow Link-header pagination to exhaustion, yielding each page's items. */
  async #paginate<T>(path: string, key: string, perPage = 100): Promise<T[]> {
    let url: string | null = `${this.#baseUrl}${path}${path.includes("?") ? "&" : "?"}per_page=${perPage}`;
    const out: T[] = [];

    while (url) {
      const res: Response = await this.#request(url);
      if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${await res.text()}`);

      const body = (await res.json()) as Record<string, unknown>;
      out.push(...((body[key] ?? []) as T[]));

      // `<url>; rel="next"` — the only reliable pagination signal GitHub gives.
      const link = res.headers.get("link");
      const next = link?.split(",").find((part) => part.includes('rel="next"'));
      url = next ? (/<([^>]+)>/.exec(next)?.[1] ?? null) : null;
    }

    return out;
  }

  listWorkflowRuns(owner: string, repo: string): Promise<WorkflowRun[]> {
    return this.#paginate<WorkflowRun>(`/repos/${owner}/${repo}/actions/runs`, "workflow_runs");
  }

  /** Jobs for one specific attempt. Never use the default endpoint for flake work. */
  listJobsForAttempt(owner: string, repo: string, runId: number, attempt: number): Promise<Job[]> {
    return this.#paginate<Job>(
      `/repos/${owner}/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`,
      "jobs",
    );
  }

  listJobsForRun(owner: string, repo: string, runId: number): Promise<Job[]> {
    return this.#paginate<Job>(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, "jobs");
  }

  /**
   * Stream a job log to a consumer. The log is never returned whole and never
   * written to disk — ADR-0003. The callback sees each line once.
   */
  async streamJobLog(
    owner: string,
    repo: string,
    jobId: number,
    onLine: (line: string) => void,
  ): Promise<void> {
    const url = `${this.#baseUrl}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;
    this.#requests += 1;
    let res = await fetch(url, { headers: this.#headers(), redirect: "manual" });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Log redirect for job ${jobId} carried no Location`);
      // Deliberately unauthenticated: the redirect target is blob storage, and
      // forwarding credentials to it would leak them to a third party.
      this.#requests += 1;
      res = await fetch(location);
    }

    if (!res.ok || !res.body) throw new Error(`Log download for job ${jobId} → ${res.status}`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) onLine(buffer);
  }
}
