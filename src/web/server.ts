/**
 * The report page.
 *
 *   pnpm web        → http://localhost:3000
 *
 * Server-rendered, no build step, no client framework. The discipline from the
 * design session was "one excellent report page, not an analytics suite", and
 * this is deliberately that.
 *
 * ADR-0005 consequence: on most repos the confirmed section will be thin and
 * the suspected section long. The page has to be honest about that rather than
 * hiding it, so proven and unproven findings are visually distinct and the
 * summary says which one you are mostly looking at.
 */

import { createServer, type ServerResponse } from "node:http";

import { closePool, loadGroups, loadRepos, loadSuspected, migrate } from "../db/index.ts";
import { priceRunner } from "../detect/index.ts";

const PORT = Number(process.env["PORT"] ?? 3000);

const RATES: Record<string, number> = { hosted: 1, "self-hosted": 0, unknown: 0 };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === '"' ? "&quot;" : "&#39;",
  );
}

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function usdFor(runner: string, runnerClass: string, seconds: number): number {
  if (runnerClass !== "hosted") return 0;
  return (seconds / 60) * priceRunner([runner]).usdPerMinute * (RATES[runnerClass] ?? 1);
}

function relativeTime(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --panel: #fff; --ink: #16171a; --muted: #6b6f76;
    --line: #e6e6e3; --accent: #b4432c; --proven: #1f6f43; --unproven: #8a6d1f;
    --chip: #f0f0ee;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111214; --panel: #191a1d; --ink: #ececec; --muted: #9aa0a8;
      --line: #2a2c31; --accent: #e0714f; --proven: #58c08a; --unproven: #d6b45c;
      --chip: #232529;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 940px; margin: 0 auto; padding: 40px 24px 80px; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 20px; margin-bottom: 28px; }
  h1 { font-size: 19px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h1 span { color: var(--accent); }
  .sub { color: var(--muted); font-size: 13px; }
  .headline {
    font-size: 30px; font-weight: 600; letter-spacing: -0.02em;
    margin: 26px 0 6px;
  }
  .headline em { font-style: normal; color: var(--accent); }
  .caveat {
    background: var(--chip); border-left: 3px solid var(--unproven);
    padding: 12px 16px; border-radius: 0 6px 6px 0; margin: 20px 0;
    font-size: 13.5px; color: var(--muted);
  }
  nav { display: flex; gap: 6px; margin: 22px 0 30px; flex-wrap: wrap; }
  nav a {
    font-size: 13px; padding: 5px 12px; border-radius: 20px; text-decoration: none;
    color: var(--muted); border: 1px solid var(--line);
  }
  nav a.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted); margin: 40px 0 4px; font-weight: 600;
  }
  h2 + p { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
  .row {
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    padding: 16px 18px; margin-bottom: 8px; display: flex; gap: 18px; align-items: baseline;
  }
  .rank { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 13px; min-width: 22px; }
  .body { flex: 1; min-width: 0; }
  .title { font-weight: 550; letter-spacing: -0.005em; word-break: break-word; }
  .repo { color: var(--muted); font-weight: 400; }
  .meta { color: var(--muted); font-size: 13px; margin-top: 5px; display: flex; gap: 14px; flex-wrap: wrap; }
  .cost { text-align: right; white-space: nowrap; }
  .cost strong { display: block; font-size: 17px; font-variant-numeric: tabular-nums; }
  .cost span { font-size: 12.5px; color: var(--muted); }
  .tag {
    font-size: 11px; padding: 2px 7px; border-radius: 4px; background: var(--chip);
    color: var(--muted); letter-spacing: 0.02em;
  }
  .tag.proven { color: var(--proven); }
  .tag.unproven { color: var(--unproven); }
  code {
    display: block; margin-top: 9px; padding: 8px 10px; background: var(--chip);
    border-radius: 5px; font-size: 12px; color: var(--muted); overflow-x: auto;
    white-space: pre; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .empty {
    text-align: center; padding: 48px 20px; color: var(--muted);
    border: 1px dashed var(--line); border-radius: 8px;
  }
  .empty strong { display: block; color: var(--ink); margin-bottom: 6px; }
  footer { margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--line);
           color: var(--muted); font-size: 12.5px; }
`;

interface PageData {
  days: number | null;
  groups: Awaited<ReturnType<typeof loadGroups>>;
  suspected: Awaited<ReturnType<typeof loadSuspected>>;
  repos: Awaited<ReturnType<typeof loadRepos>>;
}

function renderPage({ days, groups, suspected, repos }: PageData): string {
  const wastedSeconds = groups.reduce((n, g) => n + g.wastedSeconds, 0);
  const usd = groups.reduce((n, g) => n + usdFor(g.runner, g.runnerClass, g.wastedSeconds), 0);
  const occurrences = groups.reduce((n, g) => n + g.occurrences, 0);
  const window = days ? `the last ${days} days` : "all recorded history";

  // ADR-0005: be explicit when the picture is mostly unproven.
  const mostlyUnproven = groups.length === 0 && suspected.length > 0;

  const tab = (label: string, value: number | null) => {
    const href = value === null ? "/" : `/?days=${value}`;
    return `<a href="${href}" class="${days === value ? "on" : ""}">${label}</a>`;
  };

  const confirmedSection =
    groups.length === 0
      ? `<div class="empty">
           <strong>No confirmed flakes in ${escapeHtml(window)}.</strong>
           Proving a flake needs the same commit to both pass and fail. That is rare:
           only about 1.5% of workflow runs are ever rerun.
           ${suspected.length > 0 ? "The suspected findings below are what the data does support." : ""}
         </div>`
      : groups
          .map((group, index) => {
            const cost =
              group.runnerClass === "self-hosted"
                ? "self-hosted"
                : group.runnerClass === "unknown"
                  ? `unpriced runner`
                  : `~$${usdFor(group.runner, group.runnerClass, group.wastedSeconds).toFixed(2)}`;
            const evidence =
              group.evidence === "rerun-attempt" ? "proven by rerun" : "proven across runs";
            return `
      <div class="row">
        <div class="rank">${index + 1}</div>
        <div class="body">
          <div class="title">${escapeHtml(group.job)}
            <span class="repo">— ${escapeHtml(group.repo)} · ${escapeHtml(group.workflow)}</span>
          </div>
          <div class="meta">
            <span class="tag proven">${evidence}</span>
            <span>${group.occurrences}× · last ${relativeTime(group.lastSeen)}</span>
            <span>${escapeHtml(group.runner)}</span>
            ${group.likelyCause ? `<span>likely ${escapeHtml(group.likelyCause)} (${escapeHtml(group.causeConfidence ?? "")} confidence)</span>` : ""}
          </div>
          ${group.excerpt ? `<code>${escapeHtml(group.excerpt)}</code>` : ""}
        </div>
        <div class="cost">
          <strong>${minutes(group.wastedSeconds)}</strong>
          <span>${cost}</span>
        </div>
      </div>`;
          })
          .join("");

  const suspectedSection =
    suspected.length === 0
      ? ""
      : `
    <h2>Suspected</h2>
    <p>Intermittent failures with no same-commit proof. Not stated as fact — treat as leads, not findings.</p>
    ${suspected
      .slice(0, 25)
      .map(
        (s) => `
      <div class="row">
        <div class="body">
          <div class="title">${escapeHtml(s.job)}
            <span class="repo">— ${escapeHtml(s.repo)} · ${escapeHtml(s.workflow)}</span>
          </div>
          <div class="meta"><span class="tag unproven">unproven</span></div>
        </div>
        <div class="cost">
          <strong>${(s.failureRate * 100).toFixed(1)}%</strong>
          <span>${s.failures} of ${s.totalRuns} runs</span>
        </div>
      </div>`,
      )
      .join("")}`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flake report — AlertShield</title>
<style>${STYLES}</style>
</head><body><div class="wrap">
  <header>
    <h1>Alert<span>Shield</span></h1>
    <div class="sub">${repos.length} repositories · ranked by wasted runner time</div>
  </header>

  <div class="headline">
    ${groups.length > 0
      ? `<em>${minutes(wastedSeconds)}</em> wasted across ${occurrences} confirmed flakes`
      : `<em>${suspected.length}</em> suspected flaky ${suspected.length === 1 ? "job" : "jobs"}`}
  </div>
  <div class="sub">
    in ${escapeHtml(window)}${usd > 0 ? ` · about $${usd.toFixed(2)} in runner cost` : ""}
  </div>

  ${mostlyUnproven
      ? `<div class="caveat">
           Nothing here is proven. Every finding below is a statistical lead, because
           no commit in this window both passed and failed. Confidence should be
           correspondingly low.
         </div>`
      : ""}

  <nav>
    ${tab("7 days", 7)}${tab("30 days", 30)}${tab("90 days", 90)}${tab("All time", null)}
  </nav>

  <h2>Confirmed</h2>
  <p>The same commit both passed and failed. Not an estimate.</p>
  ${confirmedSection}
  ${suspectedSection}

  <footer>
    Ranked by wasted minutes, measured from job timestamps — never estimated.
    Dollar figures derive from published runner rates and are $0 for self-hosted.
    Logs are read in memory to attribute causes and are never stored.
  </footer>
</div></body></html>`;
}

const ran = await migrate();
if (ran.length > 0) console.error(`Applied migrations: ${ran.join(", ")}`);

createServer((req, res: ServerResponse) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      const daysParam = url.searchParams.get("days");
      const days = daysParam ? Number(daysParam) : null;

      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        return void res.end("ok");
      }

      const [groups, suspected, repos] = await Promise.all([
        loadGroups(days),
        loadSuspected(),
        loadRepos(),
      ]);

      if (url.pathname === "/api/report") {
        const body = JSON.stringify({ days, groups, suspected, repos }, null, 2);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(body);
      }

      if (url.pathname !== "/") {
        res.writeHead(404, { "content-type": "text/plain" });
        return void res.end("Not found");
      }

      const html = renderPage({ days, groups, suspected, repos });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (error) {
      console.error(error);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`Error: ${String(error)}`);
    }
  })();
}).listen(PORT, () => {
  console.log(`Report page on http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  void closePool().then(() => process.exit(0));
});
