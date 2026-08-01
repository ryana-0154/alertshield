/**
 * Offline analyzer entry point.
 *
 *   pnpm analyze                          all fixture repos via the mock API
 *   pnpm analyze acme/web-app             one repo
 *   pnpm analyze --days 30                trailing window only
 *   pnpm analyze --json                   machine-readable output
 *   pnpm analyze --no-logs                skip log download, step heuristic only
 *
 * Point at real GitHub by setting GITHUB_API_BASE_URL=https://api.github.com
 * and GITHUB_TOKEN. Public repos need no token scopes.
 */

import { GitHubClient } from "./github/client.ts";
import { detectFlakes, type DetectionResult } from "./detect/index.ts";
import { buildReport, renderText } from "./report.ts";

interface Args {
  repos: string[];
  days: number | null;
  json: boolean;
  skipLogs: boolean;
  maxRuns: number;
}

function parseArgs(argv: string[]): Args {
  // Default cap keeps a single repo to ~5 requests. Large repos report 40,000
  // runs; uncapped pagination burns the hourly rate limit on one repository.
  const args: Args = { repos: [], days: null, json: false, skipLogs: false, maxRuns: 500 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") args.json = true;
    else if (arg === "--no-logs") args.skipLogs = true;
    else if (arg === "--days") args.days = Number(argv[++i]);
    else if (arg === "--max-runs") args.maxRuns = Number(argv[++i]);
    else if (!arg.startsWith("-")) args.repos.push(arg);
  }
  return args;
}

async function discoverRepos(baseUrl: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/_fixtures/repos`);
  if (!res.ok) throw new Error("No repos given and the fixture server is not reachable.");
  return (await res.json()) as string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env["GITHUB_API_BASE_URL"] ?? "https://api.github.com";
  const client = new GitHubClient({ baseUrl });
  const now = new Date();

  const repos = args.repos.length > 0 ? args.repos : await discoverRepos(baseUrl);
  const since = args.days ? new Date(now.getTime() - args.days * 86_400_000) : undefined;

  if (!args.json) {
    console.error(
      `Analyzing ${repos.length} repo(s) via ${baseUrl}` +
        (since ? ` since ${since.toISOString().slice(0, 10)}` : "") +
        (args.skipLogs ? " (logs skipped)" : ""),
    );
  }

  const results: DetectionResult[] = [];
  for (const fullName of repos) {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) throw new Error(`Expected owner/repo, got "${fullName}"`);
    const result = await detectFlakes(client, owner, repo, {
      since,
      skipLogs: args.skipLogs,
      maxRuns: args.maxRuns,
      now,
    });
    results.push(result);
    if (!args.json) {
      console.error(
        `  ${fullName.padEnd(28)} ${String(result.runsAnalysed).padStart(5)} runs → ` +
          `${result.confirmed.length} confirmed, ${result.suspected.length} suspected`,
      );
    }
  }

  const report = buildReport(results, now);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderText(report));
    console.error(`${client.requestCount} API requests.`);
  }
}

await main();
