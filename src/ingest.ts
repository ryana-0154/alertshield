/**
 * Ingest: analyse repositories and persist the findings.
 *
 *   pnpm ingest acme/web-app                      one repo
 *   pnpm ingest --file repos.txt                  a list, one per line
 *   pnpm ingest --days 30 --max-runs 300 …        bound the work
 *
 * Runs migrations first, so a fresh database needs no separate setup step.
 * Safe to re-run: findings are upserted on (repo, run, job).
 */

import { readFile } from "node:fs/promises";

import { GitHubClient } from "./github/client.ts";
import { detectFlakes } from "./detect/index.ts";
import {
  closePool,
  finishIngestion,
  migrate,
  saveResult,
  startIngestion,
  upsertRepo,
} from "./db/index.ts";

interface Args {
  repos: string[];
  file: string | null;
  days: number | null;
  maxRuns: number;
  skipLogs: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { repos: [], file: null, days: null, maxRuns: 500, skipLogs: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--file") args.file = argv[++i] ?? null;
    else if (arg === "--days") args.days = Number(argv[++i]);
    else if (arg === "--max-runs") args.maxRuns = Number(argv[++i]);
    else if (arg === "--no-logs") args.skipLogs = true;
    else if (!arg.startsWith("-")) args.repos.push(arg);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let repos = args.repos;
  if (args.file) {
    const contents = await readFile(args.file, "utf8");
    repos = [
      ...repos,
      ...contents
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    ];
  }

  if (repos.length === 0) {
    console.error("Usage: pnpm ingest <owner/repo…> [--file list.txt] [--days N] [--max-runs N]");
    process.exit(1);
  }

  const ran = await migrate();
  if (ran.length > 0) console.error(`Applied migrations: ${ran.join(", ")}`);

  const client = new GitHubClient();
  const since = args.days ? new Date(Date.now() - args.days * 86_400_000) : undefined;
  let failures = 0;

  for (const fullName of repos) {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) {
      console.error(`  skipping "${fullName}" — expected owner/repo`);
      failures += 1;
      continue;
    }

    const repoId = await upsertRepo(fullName);
    const ingestionId = await startIngestion(repoId);
    const before = client.requestCount;

    try {
      const result = await detectFlakes(client, owner, repo, {
        since,
        maxRuns: args.maxRuns,
        skipLogs: args.skipLogs,
      });
      await saveResult(repoId, result);
      await finishIngestion(ingestionId, {
        runsAnalysed: result.runsAnalysed,
        apiRequests: client.requestCount - before,
      });
      console.error(
        `  ${fullName.padEnd(34)} ${String(result.runsAnalysed).padStart(5)} runs → ` +
          `${result.confirmed.length} confirmed, ${result.suspected.length} suspected`,
      );
    } catch (error) {
      failures += 1;
      // One bad repo must not abort a bulk ingest.
      await finishIngestion(ingestionId, {
        runsAnalysed: 0,
        apiRequests: client.requestCount - before,
        error: String(error).slice(0, 500),
      });
      console.error(`  ${fullName.padEnd(34)} FAILED: ${String(error).slice(0, 120)}`);
    }
  }

  console.error(
    `\nDone. ${repos.length - failures}/${repos.length} repos ingested, ${client.requestCount} API requests.`,
  );
  await closePool();
  if (failures === repos.length) process.exit(1);
}

await main();
