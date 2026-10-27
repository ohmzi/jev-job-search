/**
 * The dashboard page: one HTML file with its style and script inline, no library, no network
 * beyond the server it came from. With data embedded it is a snapshot a person can keep.
 */
import type { Report } from "./data.js";
import { REPORT, reportTitle } from "../config.js";
import { STATUS_WORDS } from "../log/csv.js";
import { LEFT_FOR_YOU } from "./data.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** A small round mark in the board's accent, so a tab can be told apart from the other four. */
const favicon = (accent: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${accent}"/></svg>`)}`;

/**
 * The page. With a snapshot it is a file to keep, read-only. Without one it is live, and `token` is
 * what lets it send a change back. `port` is the port the live page is served on, which says
 * which of the five boards it is.
 */
export function reportPage(snapshot: Report | null, token = "", port?: number): string {
  const embedded = snapshot ? `<script id="data" type="application/json">${JSON.stringify(snapshot).replace(/</g, "\\u003c")}</script>` : "";
  const title = reportTitle(port);
  const accent = REPORT.portals.find((p) => p.port === port)?.accent ?? REPORT.accent;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · jobs</title>
<link rel="icon" href="${favicon(accent)}">
<style>
  :root { --ink: #16181d; --muted: #6b7280; --line: #e5e7eb; --bg: #fafafa; --card: #fff; --accent: ${accent}; --good: #16a34a; --warn: #d97706; --bad: #dc2626; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e5e7eb; --muted: #9ca3af; --line: #2a2f3a; --bg: #0f1115; --card: #171a21; --accent: color-mix(in srgb, ${accent} 70%, white); --good: #4ade80; --warn: #fbbf24; --bad: #f87171; } }
  * { box-sizing: border-box; } body { margin: 0; font: 14px/1.45 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; color: var(--ink); background: var(--bg); }
  .top { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); border-top: 4px solid var(--accent); }
  header { padding: 14px 24px 6px; display: flex; align-items: center; gap: 12px 20px; flex-wrap: wrap; justify-content: space-between; }
  .brand { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; } h1 { font-size: 20px; margin: 0; } .brand .kind { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .6px; }
  .sub { color: var(--muted); }
  .portals { display: flex; gap: 6px; flex-wrap: wrap; } .portals a { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); background: var(--card); display: inline-flex; align-items: center; gap: 6px; } .portals a i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; } .portals a.on { color: var(--ink); border-color: var(--accent); font-weight: 600; } .portals a:hover { text-decoration: none; border-color: var(--accent); }
  nav#nav { display: flex; gap: 4px; padding: 0 24px; overflow-x: auto; } nav#nav button { border: 0; background: none; color: var(--muted); padding: 10px 14px; cursor: pointer; font: inherit; border-bottom: 2px solid transparent; white-space: nowrap; } nav#nav button.on { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
  .count { display: inline-block; min-width: 20px; padding: 0 6px; margin-left: 6px; border-radius: 999px; font-size: 11px; line-height: 18px; text-align: center; background: var(--line); color: var(--ink); font-weight: 600; } nav#nav button.on .count, .tabs button.on .count { background: color-mix(in srgb, var(--accent) 25%, transparent); }
  main { padding: 0 24px 40px; max-width: 1400px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 12px 0 18px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; } .card .n { font-size: 26px; font-weight: 600; } .card .l { color: var(--muted); font-size: 12px; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .chart h3 { margin: 0 0 8px; font-size: 13px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
  .bar { display: grid; grid-template-columns: 150px 1fr 40px; gap: 8px; align-items: center; font-size: 13px; margin: 3px 0; } .bar i { display: block; height: 10px; border-radius: 5px; background: var(--accent); } .bar b { font-weight: 500; text-align: right; color: var(--muted); }
  .tabs { display: flex; gap: 6px; margin: 4px 0 10px; flex-wrap: wrap; } .tabs button { border: 1px solid var(--line); background: var(--card); color: var(--ink); padding: 6px 12px; border-radius: 999px; cursor: pointer; font: inherit; } .tabs button.on { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .tabnote { color: var(--muted); font-size: 13px; margin: 0 0 10px; }
  .toolbar { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; margin: 0 0 10px; min-height: 34px; }
  input[type=search] { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--ink); min-width: 260px; font: inherit; }
  .wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; } th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; } tbody tr:last-child td { border-bottom: 0; } tbody tr:hover { background: color-mix(in srgb, var(--accent) 4%, transparent); } tr.picked { background: color-mix(in srgb, var(--accent) 9%, transparent); }
  th { font-size: 12px; color: var(--muted); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } th[data-sort] { cursor: pointer; } th[data-sort]:hover { color: var(--ink); }
  .c-pick { width: 40px; padding-right: 4px; text-overflow: clip; } .c-applied { width: 96px; } .c-board { width: 96px; } .c-easy { width: 92px; } .c-fit { width: 54px; } .c-status { width: 116px; } .c-reply { width: 130px; } .c-notes { width: 160px; } .c-act { width: 178px; } .c-posted { width: 140px; } .c-found { width: 90px; } .c-reason { width: 25%; }
  td.ez, .meta .ez { color: var(--good); font-weight: 600; } .c-portal { width: 120px; }
  .from { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); font-weight: 500; white-space: nowrap; } .from i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; } h4 .from { margin-right: 8px; }
  td.n { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .role { font-weight: 600; } .meta { color: var(--muted); font-size: 12px; margin-top: 2px; } .meta .ez { color: var(--good); font-weight: 600; }
  .clip { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; color: var(--ink); } .clip.open { display: block; } .clip:empty { display: none; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  select, textarea { font: inherit; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--ink); padding: 4px 6px; }
  textarea.notes { width: 100%; height: 32px; resize: vertical; font-size: 13px; } textarea.notes:focus { height: 84px; outline: 2px solid color-mix(in srgb, var(--accent) 40%, transparent); }
  .status { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--line); white-space: nowrap; display: inline-block; } .status.applied { background: color-mix(in srgb, var(--good) 20%, transparent); color: var(--good); } .status.needs { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); } .status.queued { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
  .saved { color: var(--good); font-size: 12px; margin-left: 6px; } .saved.err { color: var(--bad); } .static { color: var(--muted); font-size: 12px; }
  .screen { display: none; padding-top: 16px; } .screen.on { display: block; }
  .item { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; } .item h4 { margin: 0 0 4px; font-size: 15px; } .item p { margin: 4px 0; } .item .q { margin: 10px 0 4px; font-weight: 600; }
  .item input[type=text], .item input[type=number], .item input[type=time], .item textarea, .item select { width: 100%; max-width: 640px; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--ink); font: inherit; }
  .self { display: grid; grid-template-columns: 1fr auto; gap: 8px 16px; align-items: center; padding: 10px 14px; margin-bottom: 8px; } .self .btn { margin: 0 0 0 6px; }
  .btn { border: 1px solid var(--accent); background: var(--accent); color: #fff; padding: 7px 14px; border-radius: 8px; cursor: pointer; font: inherit; margin: 8px 8px 0 0; display: inline-block; } .btn.quiet { background: none; color: var(--accent); } .btn:disabled { opacity: .45; cursor: default; } a.btn:hover { text-decoration: none; }
  .btn.sm { padding: 4px 10px; font-size: 13px; margin: 0 6px 4px 0; } select.sm { font-size: 13px; padding: 3px 4px; max-width: 100%; }
  .more { margin: 10px 0 0; }
  .line { font-size: 20px; font-weight: 600; margin: 4px 0 12px; } h2 { font-size: 15px; margin: 22px 0 10px; } h2 .count { font-size: 12px; } .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px 20px; } .grid2 label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 3px; }
  .note { color: var(--muted); font-size: 13px; } .warn { color: var(--warn); }
  @media (max-width: 800px) { header, main, nav#nav { padding-left: 16px; padding-right: 16px; } .bar { grid-template-columns: 100px 1fr 32px; } .wrap table { width: 1350px; } .c-reason { width: 260px; } .self { grid-template-columns: 1fr; } .self .btn { margin: 0 6px 0 0; } input[type=search] { min-width: 0; width: 100%; } }
</style></head>
<body>
<div class="top">
  <header>
    <div class="brand"><h1>${esc(title)}</h1><span class="kind">job search</span><span class="sub" id="when"></span><span class="static" id="mode"></span></div>
    <nav class="portals" id="portals" aria-label="Other boards"></nav>
  </header>
  <nav id="nav"></nav>
</div>
<main>
  <section class="screen" id="s-today">
    <div class="line" id="todayLine"></div>
    <div id="portalState"></div>
    <div class="cards" id="cards"></div>
    <div class="charts">
      <div class="card chart"><h3>Applications per day</h3><div id="byDay"></div></div>
      <div class="card chart"><h3>Sent, by job board</h3><div id="byBoard"></div></div>
      <div class="card chart"><h3>Every job considered, by status</h3><div id="byStatus"></div></div>
      <div class="card chart" id="byPortalCard" hidden><h3>Sent, by portal</h3><div id="byPortal"></div></div>
    </div>
  </section>
  <section class="screen" id="s-recent">
    <div class="toolbar"><input type="search" id="qRecent" placeholder="Filter by company, role, board, place, status"><span class="sub" id="countRecent"></span></div>
    <div id="recent"></div>
  </section>
  <section class="screen" id="s-needs">
    <div class="toolbar"><input type="search" id="qNeeds" placeholder="Filter by company, role, reason"><span class="sub" id="countNeeds"></span></div>
    <div id="needs"></div>
  </section>
  <section class="screen" id="s-apps">
    <div class="tabs" id="tabs"></div>
    <p class="tabnote" id="tabnote"></p>
    <div class="toolbar"><input type="search" id="q" placeholder="Filter by company, role, board, reason"><span class="sub" id="count"></span></div>
    <div id="apps"></div>
  </section>
  <section class="screen" id="s-auto"><div id="auto"></div></section>
</main>
${embedded}
<script>
(() => {
  const STATUSES = ${JSON.stringify(REPORT.statuses)};
  const WORDS = ${JSON.stringify(STATUS_WORDS)};
  const PORTALS = ${JSON.stringify(REPORT.portals)};
  const HERE = ${JSON.stringify(port ?? null)};
  const PAGE = ${REPORT.pageSize};
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const embedded = document.getElementById("data");
  const live = !embedded;
  const LEFT = ${JSON.stringify(LEFT_FOR_YOU)};
  const WAITING = ["awaiting_user_action", "awaiting_email_verification", "submission_unknown"];
  // Each tab shows the columns that matter for what is in it.
  const TABS = [
    { key: "applied", label: "Applied", keep: (r) => r.status_key === "applied", cols: ["applied", "job", "board", "easy", "reply", "notes", "act"], sort: ["applied_on", -1], note: "Sent and confirmed. A reply the inbox placed shows under Reply." },
    { key: "waiting", label: "Waiting for you", keep: (r) => WAITING.includes(r.status_key), cols: ["pick", "job", "board", "easy", "status", "reason", "notes", "act"], sort: ["company", 1], note: "A form open for you, or one that was clicked and never confirmed. If you sent it, mark it applied." },
    { key: "manual", label: "Left for you", keep: (r) => LEFT.includes(r.status_key), cols: ["pick", "job", "board", "easy", "fit", "status", "reason", "notes", "act"], sort: ["fit", -1], note: "The tool could not finish these. Apply on the site yourself, then mark them applied, or skip them." },
    { key: "takehome", label: "Take-home", keep: (r) => !!r.takehome, cols: ["applied", "job", "board", "status", "reply", "notes", "act"], sort: ["applied_on", -1], note: "Applications that came with a take-home task." },
    { key: "queued", label: "Queued", keep: (r) => r.status_key === "queued", cols: ["pick", "job", "board", "easy", "fit", "notes", "act"], sort: ["fit", -1], note: "Next in line for /apply, best fit first." },
    { key: "all", label: "Everything", keep: () => true, cols: ["pick", "applied", "job", "board", "easy", "fit", "status", "reason", "notes", "act"], sort: ["applied_on", -1], note: "Every job the tool has considered." },
  ];
  const TOKEN = ${JSON.stringify(token)};
  let SCREENS = live ? [["today", "Today"], ["recent", "Last 12 hours"], ["needs", "Needs you"], ["apps", "Applications"], ["auto", "Automation"]] : [["today", "Today"], ["recent", "Last 12 hours"], ["apps", "Applications"]];
  // A link can open one screen directly: /#recent opens Last 12 hours.
  const startScreen = location.hash.replace(/^#/, "");
  let data = null, needs = null, auto = null, screen = SCREENS.some(([k]) => k === startScreen) ? startScreen : "today", tab = "applied", q = "", qRecent = "", qNeeds = "";
  let appRows = [], recentRows = [];
  const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-jev-token": TOKEN }, body: JSON.stringify(body) });
  const needCount = () => needs ? needs.waiting.length + needs.questions.length + needs.unconfirmed.length + (needs.self || []).length + needs.mail.length + (needs.elsewhere || []).length : 0;
  // On the combined board every job and card belongs to a portal: its key names the portal too,
  // and a change made here is sent with that portal's port, so the portal makes it.
  const keyOf = (x) => (x.port ? x.port + ":" : "") + x.id;
  const routed = (x, body) => x && x.port ? { ...body, port: x.port } : body;
  const items = new Map(), rowsByKey = new Map();
  const portalOf = (port) => PORTALS.find((p) => p.port === port);
  const from = (x) => x.portal ? '<span class="from"><i style="background:' + esc((portalOf(x.port) || {}).accent || "") + '"></i>' + esc(x.portal) + "</span>" : "";
  const portalLink = (port, hash) => { const p = portalOf(port); if (!p) return "#"; return (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? "http://127.0.0.1:" + p.port : p.url) + "/#" + hash; };
  const recentCount = () => data && data.recent ? data.recent.length : 0;
  const badge = (n) => n ? '<span class="count">' + n + "</span>" : "";

  // The switcher to the other boards: local ports from this machine, public addresses from outside.
  function renderPortals() {
    if (!live || !PORTALS.some((p) => p.port === HERE)) return;
    const local = /^(127\\.0\\.0\\.1|localhost)$/.test(location.hostname);
    $("#portals").innerHTML = PORTALS.map((p) => '<a class="' + (p.port === HERE ? "on" : "") + '" href="' + esc((local ? "http://127.0.0.1:" + p.port : p.url) + "/" + location.hash) + '"><i style="background:' + esc(p.accent) + '"></i>' + esc(p.title) + "</a>").join("");
  }
  function renderNav() {
    const count = (k) => badge(k === "needs" ? needCount() : k === "recent" ? recentCount() : 0);
    $("#nav").innerHTML = SCREENS.map(([k, l]) => '<button class="' + (k === screen ? "on" : "") + '" data-screen="' + k + '">' + l + count(k) + "</button>").join("");
    for (const [k] of SCREENS) $("#s-" + k).classList.toggle("on", k === screen);
  }

  // One row shape for every table, from the record or from the queue.
  const after = (s) => s.includes(":") ? s.slice(s.indexOf(":") + 1).trim() : "";
  const fromApp = (r) => ({ id: r.job_id, company: r.company, role: r.role, link: r.job_link, location: r.location, board: r.ats, easy: r.easy_apply, fit: r.fit_score === "" || r.fit_score == null ? null : Number(r.fit_score), status_key: r.status_key, status: r.status.replace(/:.*$/s, ""), reason: r.skip_reason || after(r.status), applied_on: (r.applied_on || "").slice(0, 10), reply: r.response, reply_on: r.response_on, notes: r.notes, takehome: r.takehome_link, in_queue: r.in_queue !== false, portal: r.portal, port: r.port, key: keyOf({ id: r.job_id, port: r.port }) });
  const fromRecent = (r) => ({ id: r.id, company: r.company, role: r.title, link: r.link, location: r.location, board: r.board, easy: r.easy_apply === true ? "Yes" : r.easy_apply === false ? "No" : "", fit: r.fit_score, status_key: r.status_key, status: r.status, reason: r.why, posted: r.posted_at || r.posted_on, found_at: r.found_at, age: r.age_hours, notes: "", in_queue: true, portal: r.portal, port: r.port, key: keyOf(r) });

  // A filter matches any word of what a row shows: company, role, place, board, status, reason.
  const matches = (needle, ...parts) => !needle || parts.join(" ").toLowerCase().includes(needle.toLowerCase());
  const rowText = (r) => [r.company, r.role, r.location, r.board, r.portal, r.easy === "Yes" ? "easy apply" : "", r.status, r.reason];
  const statusClass = (k) => k === "applied" ? "applied" : k === "queued" ? "queued" : LEFT.includes(k) ? "needs" : "";
  const canChange = (r) => live && r.in_queue;
  const canPick = (r) => canChange(r) && r.status_key !== "applied";
  const COLS = {
    pick: { label: "", cls: "c-pick" },
    applied: { label: "Applied on", cls: "c-applied", sort: "applied_on", cell: (r) => '<td class="n">' + esc(r.applied_on) + "</td>" },
    job: { label: "Job", cls: "c-job", sort: "company", cell: (r) => '<td><a class="role" href="' + esc(r.link) + '" target="_blank" rel="noopener">' + esc(r.role) + '</a><div class="meta">' + [esc(r.company), esc(r.location)].filter(Boolean).join(" · ") + (r.takehome ? ' · <a href="' + esc(r.takehome) + '" target="_blank" rel="noopener">take-home</a>' : "") + "</div></td>" },
    portal: { label: "Portal", cls: "c-portal", sort: "portal", cell: (r) => "<td>" + from(r) + "</td>" },
    board: { label: "Board", cls: "c-board", sort: "board", cell: (r) => "<td>" + esc(r.board) + "</td>" },
    easy: { label: "Easy Apply", cls: "c-easy", sort: "easy", cell: (r) => '<td class="' + (r.easy === "Yes" ? "ez" : "") + '">' + esc(r.easy) + "</td>" },
    fit: { label: "Fit", cls: "c-fit", sort: "fit", cell: (r) => '<td class="n" title="' + esc(r.fit ?? "") + '">' + (r.fit == null || isNaN(r.fit) ? "" : Math.round(r.fit * 100) + "%") + "</td>" },
    status: { label: "Status", cls: "c-status", sort: "status", cell: (r) => '<td><span class="status ' + statusClass(r.status_key) + '">' + esc(r.status) + "</span></td>" },
    reason: { label: "Reason", cls: "c-reason", sort: "reason", cell: (r) => '<td><div class="clip" title="Click to read it all">' + esc(r.reason) + "</div></td>" },
    reply: { label: "Reply", cls: "c-reply", sort: "reply", cell: (r) => "<td>" + (r.reply ? esc(r.reply) + '<div class="meta">' + esc(r.reply_on) + "</div>" : "") + "</td>" },
    notes: { label: "Notes", cls: "c-notes", cell: (r) => "<td>" + (canChange(r) ? '<textarea class="notes" data-notes="' + esc(r.key) + '" placeholder="Add a note">' + esc(r.notes) + "</textarea>" : esc(r.notes)) + "</td>" },
    posted: { label: "Posted", cls: "c-posted", sort: "posted", cell: (r) => '<td class="n">' + esc(r.posted ? (r.posted.length > 10 ? new Date(r.posted).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : r.posted) : "unknown") + "</td>" },
    found: { label: "Found", cls: "c-found", sort: "found_at", cell: (r) => '<td class="n">' + (r.age ? r.age + "h ago" : "under 1h") + "</td>" },
    act: { label: "", cls: "c-act", cell: (r) => {
      if (!live) return "<td></td>";
      if (!r.in_queue) return '<td><span class="note" title="This job is in the record only, not in the queue, so it cannot be changed here">record only</span></td>';
      const menu = '<select class="sm" data-id="' + esc(r.key) + '" data-was="' + esc(r.status_key) + '" aria-label="Change status"><option value="">Change status</option>' + STATUSES.filter((s) => s !== r.status_key).map((s) => '<option value="' + s + '">' + esc(WORDS[s] || s) + "</option>").join("") + "</select>";
      return "<td>" + (r.status_key !== "applied" ? '<button class="btn sm" data-mark="' + esc(r.key) + '" data-was="' + esc(r.status_key) + '">Applied</button>' : "") + menu + '<span class="saved"></span></td>';
    } },
  };

  // Each table keeps its own sort, how many rows it shows, and which rows are ticked, across refreshes.
  const tables = {};
  const stateOf = (key, sort) => tables[key] || (tables[key] = { sortKey: sort[0], sortDir: sort[1], shown: PAGE, picked: new Set(), rows: [] });
  const cmp = (a, b, k) => {
    const x = a[k], y = b[k];
    if (typeof x === "number" || typeof y === "number") return (x ?? -Infinity) - (y ?? -Infinity);
    return String(x ?? "").localeCompare(String(y ?? ""));
  };
  function drawTable(key, rows, cols, sort, labels = {}) {
    const st = stateOf(key, sort);
    rows = [...rows].sort((a, b) => cmp(a, b, st.sortKey) * st.sortDir || String(a.company).localeCompare(String(b.company)));
    st.rows = rows;
    const ids = new Set(rows.map((r) => r.key));
    for (const r of rows) rowsByKey.set(r.key, r);
    for (const id of [...st.picked]) if (!ids.has(id)) st.picked.delete(id);
    const shown = rows.slice(0, st.shown);
    const pickable = live && cols.includes("pick");
    const head = cols.map((c) => {
      const col = COLS[c];
      if (c === "pick") return '<th class="c-pick">' + (pickable ? '<input type="checkbox" data-all="' + key + '" aria-label="Select all shown"' + (shown.some(canPick) && shown.filter(canPick).every((r) => st.picked.has(r.key)) ? " checked" : "") + ">" : "") + "</th>";
      const label = labels[c] ?? col.label;
      return '<th class="' + col.cls + '"' + (col.sort ? ' data-sort="' + col.sort + '" data-table="' + key + '"' : "") + ">" + label + (col.sort && st.sortKey === col.sort ? (st.sortDir > 0 ? " ▲" : " ▼") : "") + "</th>";
    }).join("");
    const body = shown.map((r) => '<tr class="' + (st.picked.has(r.key) ? "picked" : "") + '">' + cols.map((c) => c === "pick" ? "<td>" + (canPick(r) ? '<input type="checkbox" data-pick="' + esc(r.key) + '" data-table="' + key + '"' + (st.picked.has(r.key) ? " checked" : "") + ' aria-label="Select">' : "") + "</td>" : COLS[c].cell(r)).join("") + "</tr>").join("") || '<tr><td colspan="' + cols.length + '" class="sub">Nothing here.</td></tr>';
    const bulk = pickable ? '<div class="toolbar" data-bulk="' + key + '"><button class="btn sm" data-bulk-to="applied" data-table="' + key + '"' + (st.picked.size ? "" : " disabled") + '>Mark selected applied</button><button class="btn sm quiet" data-bulk-to="skipped" data-table="' + key + '"' + (st.picked.size ? "" : " disabled") + '>Skip selected</button><span class="sub">' + (st.picked.size ? st.picked.size + " selected" : "Tick jobs to change several at once") + '</span><span class="saved" id="saved-bulk-' + key + '"></span></div>' : "";
    const more = rows.length > shown.length ? '<p class="more"><button class="btn quiet sm" data-more="' + key + '">Show ' + Math.min(PAGE, rows.length - shown.length) + " more</button> <span class=\\"sub\\">" + shown.length + " of " + rows.length + "</span></p>" : "";
    return bulk + '<div class="wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>" + more;
  }

  const KINDS = { confirmation: "received your application", rejection: "said no", assessment: "sent an assessment", interview: "asked for an interview", offer: "made an offer" };
  // Each list in Needs you, narrowed by the filter. The count in the tab stays the whole number.
  function renderNeeds() {
    if (!needs) return;
    const shown = Object.fromEntries(Object.entries(needs).map(([k, v]) => [k, Array.isArray(v) ? v.filter((x) => matches(qNeeds, JSON.stringify(x))) : v]));
    const total = Object.values(shown).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
    $("#countNeeds").textContent = qNeeds ? total + " of " + needCount() : "";
    drawNeeds(shown, total);
  }
  function drawNeeds(needs, total) {
    for (const v of Object.values(needs)) if (Array.isArray(v)) for (const x of v) if (x && x.id) items.set(keyOf(x), x);
    const self = needs.self || [];
    const out = [];
    if (!needCount()) out.push('<p class="note">Nothing needs you right now.</p>');
    else if (!total) out.push('<p class="note">Nothing here matches the filter.</p>');
    if (needs.questions.length) out.push("<h2>Questions only you can answer" + badge(needs.questions.length) + "</h2>");
    for (const j of needs.questions) {
      const ask = j.items.filter((x) => x.kind === "ask");
      out.push('<div class="item" data-job="' + esc(keyOf(j)) + '"><h4>' + from(j) + esc(j.company) + " needs " + (j.items.length === 1 ? "one answer" : j.items.length + " answers") + '</h4><p class="note"><a href="' + esc(j.link) + '" target="_blank" rel="noopener">' + esc(j.title) + "</a></p>" +
        j.items.map((x, n) => '<p class="q">' + esc(x.question) + "</p>" + (x.kind !== "ask" ? '<p class="note warn">' + esc(x.note) + "</p>" :
          (x.options.length ? '<select data-q="' + n + '"><option value="">Choose</option>' + x.options.map((o) => "<option>" + esc(o) + "</option>").join("") + "</select>" : '<textarea data-q="' + n + '" placeholder="Your answer, in your own words"></textarea>') +
          '<p class="note"><label><input type="checkbox" data-keep="' + n + '"> Remember for future applications</label></p>')).join("") +
        (ask.length ? '<button class="btn" data-answer="' + esc(keyOf(j)) + '">Save for next run</button><span class="saved" id="saved-' + esc(keyOf(j)) + '"></span><p class="note">Nothing is sent now. The job goes back in the queue, and your next /apply or daily run fills it with this answer.</p>' : "") + "</div>");
    }
    if (needs.waiting.length) out.push("<h2>Forms open and waiting for you" + badge(needs.waiting.length) + "</h2>");
    for (const w of needs.waiting) out.push('<div class="item"><h4>' + from(w) + esc(w.company) + ": " + esc(w.todo) + '</h4><p class="note">' + esc(w.title) + "</p><p>" + esc(w.reason) + "</p>" +
      (w.open ? '<button class="btn" data-show="' + esc(keyOf(w)) + '">Show the form</button>' : '<span class="note">Its window was closed. It is on your by-hand list.</span>') +
      (w.mail ? '<a class="btn quiet" href="' + esc(w.mail) + '" target="_blank" rel="noopener">Find the email</a>' : "") +
      '<p class="note">Do it in the tool\u2019s Chrome window, then type /resume in Claude Code.</p></div>');
    if (needs.unconfirmed.length) out.push("<h2>Clicked, and no confirmation seen" + badge(needs.unconfirmed.length) + "</h2>");
    for (const u of needs.unconfirmed) out.push('<div class="item"><h4>' + from(u) + esc(u.company) + '</h4><p class="note"><a href="' + esc(u.link) + '" target="_blank" rel="noopener">' + esc(u.title) + '</a></p><p>Look for a confirmation email from them. It is never sent again until you say which it was.</p><span class="saved" id="saved-' + esc(keyOf(u)) + '"></span><button class="btn" data-set="' + esc(keyOf(u)) + '" data-to="applied" data-was="submission_unknown">I got a confirmation</button><button class="btn quiet" data-set="' + esc(keyOf(u)) + '" data-to="queued" data-was="submission_unknown">It was not sent. Try again</button></div>');
    if (needs.mail.length) out.push("<h2>Emails the tool could not place" + badge(needs.mail.length) + "</h2>");
    for (const m of needs.mail) out.push('<div class="item" data-mail="' + esc(keyOf(m)) + '"><h4>' + from(m) + esc(m.subject) + '</h4><p class="note">From ' + esc(m.from) + ", " + esc(m.on) + ". " + esc(m.why) + "</p>" +
      '<div class="grid2"><div><label>Which application</label><select data-mjob>' + '<option value="">Choose</option>' + m.jobs.map((j) => '<option value="' + esc(j.id) + '">' + esc(j.company) + " | " + esc(j.title) + "</option>").join("") + "</select></div>" +
      "<div><label>What it says</label><select data-mkind>" + Object.entries(KINDS).map(([k, l]) => '<option value="' + k + '"' + (k === m.kind ? " selected" : "") + ">They " + l + "</option>").join("") + "</select></div></div>" +
      '<button class="btn" data-mail-ok="' + esc(keyOf(m)) + '">Save</button><button class="btn quiet" data-mail-no="' + esc(keyOf(m)) + '">Not about an application</button></div>');
    if (self.length) out.push("<h2>Apply on the employer\u2019s site" + badge(self.length) + '</h2><p class="note">The tool cannot fill these. Open the posting, apply there, then say so here.</p>');
    for (const s of self) out.push('<div class="item self"><div><a class="role" href="' + esc(s.link) + '" target="_blank" rel="noopener">' + esc(s.title) + '</a><div class="meta">' + (s.portal ? from(s) + " · " : "") + esc(s.company) + " · " + esc(s.reason) + "</div></div>" +
      '<div><a class="btn quiet sm" href="' + esc(s.link) + '" target="_blank" rel="noopener">Open posting</a><button class="btn sm" data-set="' + esc(keyOf(s)) + '" data-to="applied" data-was="needs_review">I applied</button><button class="btn quiet sm" data-set="' + esc(keyOf(s)) + '" data-to="skipped" data-was="needs_review" data-reason="you chose not to apply">Not applying</button><span class="saved" id="saved-' + esc(keyOf(s)) + '"></span></div></div>');
    if ((needs.elsewhere || []).length) out.push("<h2>Waiting on a portal\u2019s own page" + badge(needs.elsewhere.length) + '</h2><p class="note">These are done on the portal itself.</p>');
    for (const e of needs.elsewhere || []) out.push('<div class="item self"><div>' + from(e) + " " + esc(e.text) + '</div><div><a class="btn quiet sm" href="' + esc(portalLink(e.port, "needs")) + '">Open ' + esc(e.portal) + "</a></div></div>");
    $("#needs").innerHTML = out.join("");
  }
  const withPortal = (cols) => data && data.combined ? cols.flatMap((c) => c === "job" ? ["job", "portal"] : [c]) : cols;
  function renderRecent() {
    if (!data) return;
    recentRows = (data.recent || []).map(fromRecent);
    const rows = recentRows.filter((r) => matches(qRecent, ...rowText(r)));
    $("#countRecent").textContent = recentRows.length ? (qRecent ? rows.length + " of " + recentRows.length : rows.length) + " job" + (recentRows.length === 1 ? "" : "s") : "";
    if (!recentRows.length) { $("#recent").innerHTML = '<p class="note">Nothing new in the last 12 hours.</p>'; return; }
    $("#recent").innerHTML =
      '<p class="tabnote">Jobs the tool first saw in the last 12 hours. <b>/apply</b> takes them before older queued jobs while they are fresh. A board-only listing waits here for its 12 hours, then moves to Needs you.</p>' +
      drawTable("recent", rows, withPortal(["pick", "job", "board", "easy", "posted", "found", "fit", "status", "reason", "act"]), ["found_at", -1], { reason: "Why here" });
  }
  const list = (v) => (v || []).join(", ");
  function renderAuto() {
    if (!auto) return;
    const p = auto.policy || auto.defaults, L = auto.limits, sch = auto.schedule;
    const last = auto.today.length ? auto.today[auto.today.length - 1] : null;
    $("#auto").innerHTML =
      '<div class="item"><h4>Apply automatically</h4>' +
      '<p><label><input type="checkbox" id="autoOn"' + (sch.on ? " checked" : "") + (auto.policy ? "" : " disabled") + '> Run every day at </label> <input type="time" id="autoAt" value="' + esc(sch.at) + '" style="width:auto"> <span class="note">' + esc(auto.timezone) + "</span></p>" +
      (sch.on && sch.next ? "<p>Next run: <b>" + esc(new Date(sch.next).toLocaleString()) + "</b></p>" : '<p class="note">' + (auto.policy ? "Off. Nothing runs by itself." : "Save your daily rules below first.") + "</p>") +
      '<p class="note">Your Mac has to be on and you signed in at that time. The tool\u2019s Chrome window opens while it works.</p>' +
      (sch.on ? '<button class="btn quiet" id="autoPause">Pause future runs</button>' : "") +
      (auto.running ? (auto.stopAsked ? '<p class="warn">A run is working now and was asked to stop. It finishes the application it is on.</p>' : '<p>A run is working now. <button class="btn quiet" id="autoStop">Stop it after this application</button></p>') : "") +
      (sch.on ? '<p class="note">Pausing removes the schedule. It does not stop a run that is already working.</p>' : "") + '<span class="saved" id="saved-auto"></span></div>' +
      '<div class="item"><h4>Your daily rules</h4>' + (auto.policyError ? '<p class="warn">' + esc(auto.policyError) + "</p>" : "") +
      '<div class="grid2">' +
      '<div><label>Applications a day (at most ' + L.maxTarget + ')</label><input type="number" id="pTarget" min="1" max="' + L.maxTarget + '" value="' + esc(p.target) + '"></div>' +
      '<div><label>Most DeepSeek may cost in a day, in dollars (JEV and the writer, both DeepSeek)</label><input type="number" id="pBudget" min="0" step="0.05" value="' + esc(p.jevBudgetUsd) + '"></div>' +
      '<div><label>Lowest fit score, 0 to 1</label><input type="number" id="pScore" min="0" max="1" step="0.05" value="' + esc(p.minScore) + '"></div>' +
      '<div><label>Where: vancouver, canada, remote, us, international (empty: anywhere)</label><input type="text" id="pWhere" value="' + esc(list(p.where)) + '"></div>' +
      '<div><label>Kinds: internship, new_grad (empty: both)</label><input type="text" id="pLevels" value="' + esc(list(p.levels)) + '"></div>' +
      '<div><label>Boards: greenhouse, lever, ashby, workday (empty: all)</label><input type="text" id="pBoards" value="' + esc(list(p.boards)) + '"></div>' +
      '<div><label>Employers never to apply to</label><input type="text" id="pExclude" value="' + esc(list(p.excludeEmployers)) + '"></div>' +
      '<div><label>Documents</label><label><input type="checkbox" id="pTailor"' + (p.documents.tailor ? " checked" : "") + '> A resume written for each job</label><label><input type="checkbox" id="pCover"' + (p.documents.cover ? " checked" : "") + "> A cover letter where a form has a box for one</label></div>" +
      '</div><button class="btn" id="pSave">Save rules</button><span class="saved" id="saved-policy"></span>' +
      '<p class="note">A run reads these rules when it starts. A change you save while one is working applies from the next run.</p>' +
      '<p class="note">Fixed limits, the same for everyone: at most ' + L.perBoard + " a day to one job board, " + L.perEmployerPerDay + " a day to one employer, " + L.gapMinutes[0] + " to " + L.gapMinutes[1] + " minutes between two applications to one board, and a run of at most " + L.maxMinutes + " minutes. A board that asks whether a person is there is left alone until tomorrow.</p></div>" +
      '<div class="item"><h4>Today</h4>' + (last ? '<p class="line">' + esc(last.sent.length + " submitted. " + (last.waiting.length + last.unconfirmed.length) + " need you. " + last.leftForYou.length + " could not be sent.") + '</p><p class="note">Stopped because ' + esc(last.stoppedBecause) + ". DeepSeek today: $" + Number(last.jevUsd).toFixed(4) + "</p>" : '<p class="note">No daily run yet today.</p>') + "</div>";
  }
  const words = (id) => $("#" + id).value.split(",").map((x) => x.trim()).filter(Boolean);
  const flash = (el, text, bad) => { if (!el) return; el.textContent = text; el.classList.toggle("err", !!bad); setTimeout(() => (el.textContent = ""), bad ? 6000 : 2500); };
  const errorOf = async (res) => { try { return (await res.json()).error || "not saved"; } catch (e) { return "not saved"; } };
  async function act(path, body, saved) {
    const res = await post(path, body);
    const el = typeof saved === "string" ? document.getElementById(saved) : saved;
    flash(el, res.ok ? "saved" : await errorOf(res), !res.ok);
    if (res.ok) await load();
    return res.ok;
  }
  const bars = (el, obj, max) => { el.innerHTML = Object.entries(obj).slice(0, 10).map(([k, v]) => '<div class="bar"><span title="' + esc(k) + '">' + esc(k) + '</span><i style="width:' + Math.max(2, 100 * v / max) + '%"></i><b>' + v + '</b></div>').join("") || '<span class="sub">nothing yet</span>'; };
  function renderToday() {
    const t = data.totals;
    $("#when").textContent = "as of " + new Date(data.generatedAt).toLocaleString();
    $("#mode").textContent = live ? "" : "snapshot: statuses cannot be changed here";
    $("#todayLine").textContent = t.appliedToday + " sent today. " + t.waitingForYou + " waiting for you. " + t.queued + " in the queue.";
    $("#cards").innerHTML = [["Applied", t.applied], ["Today", t.appliedToday], ["Unconfirmed", t.unconfirmed], ["Waiting for you", t.waitingForYou], ["Left for you", t.leftForYou], ["Queued", t.queued], ["Skipped", t.skipped], ["Considered", t.considered]].map(([l, n]) => '<div class="card"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>').join("");
    bars($("#byDay"), Object.fromEntries(data.byDay.map((d) => [d.day, d.applied])), Math.max(1, ...data.byDay.map((d) => d.applied)));
    bars($("#byBoard"), data.byBoard, Math.max(1, ...Object.values(data.byBoard)));
    bars($("#byStatus"), data.byStatus, Math.max(1, ...Object.values(data.byStatus)));
    $("#byPortalCard").hidden = !data.combined;
    if (data.combined) {
      const sent = {};
      for (const p of data.portals) sent[p.title] = data.rows.filter((r) => r.port === p.port && r.status_key === "applied").length;
      bars($("#byPortal"), sent, Math.max(1, ...Object.values(sent)));
    }
    $("#portalState").innerHTML = (data.portals || []).filter((p) => !p.ok).map((p) => '<p class="warn">' + esc(p.title) + " is not answering (" + esc(p.error) + "). Its jobs are missing here until it is back.</p>").join("");
  }
  function renderApps() {
    if (!data) return;
    appRows = data.rows.map(fromApp);
    const t = TABS.find((x) => x.key === tab);
    $("#tabs").innerHTML = TABS.map((x) => '<button class="' + (x.key === tab ? "on" : "") + '" data-tab="' + x.key + '">' + x.label + badge(appRows.filter(x.keep).length) + "</button>").join("");
    $("#tabnote").textContent = t.note;
    const rows = appRows.filter(t.keep).filter((r) => matches(q, ...rowText(r)));
    $("#count").textContent = rows.length + " job" + (rows.length === 1 ? "" : "s");
    $("#apps").innerHTML = drawTable("apps-" + t.key, rows, withPortal(t.cols), t.sort);
  }
  function redraw(key) { if (key === "recent") renderRecent(); else renderApps(); }
  const rowsOf = (key) => key === "recent" ? recentRows : appRows;

  // Several jobs at once, one change at a time, each from the status the page was showing.
  async function bulk(key, to) {
    const st = tables[key];
    const rows = rowsOf(key).filter((r) => st.picked.has(r.key));
    let done = 0, said = "";
    for (const r of rows) {
      const res = await post("/api/status", routed(r, { id: r.id, status: to, was: r.status_key, ...(to === "skipped" ? { reason: "you chose to skip it" } : {}) }));
      if (!res.ok) { said = (done ? done + " saved, then: " : "") + (await errorOf(res)); break; }
      done++;
    }
    st.picked.clear();
    await load();
    flash(document.getElementById("saved-bulk-" + key), said || done + " saved", !!said);
  }
  const save = (el, key, patch) => { const r = rowsByKey.get(key); return act("/api/status", routed(r, { id: r.id, ...patch }), el.closest("td") ? el.closest("td").querySelector(".saved") : null); };
  document.addEventListener("click", async (e) => {
    const t = e.target;
    const all = t.closest("[data-all]");
    if (all) { const st = tables[all.dataset.all]; for (const r of st.rows.slice(0, st.shown).filter(canPick)) all.checked ? st.picked.add(r.key) : st.picked.delete(r.key); redraw(all.dataset.all); return; }
    const pick = t.closest("[data-pick]");
    if (pick) { const st = tables[pick.dataset.table]; pick.checked ? st.picked.add(pick.dataset.pick) : st.picked.delete(pick.dataset.pick); redraw(pick.dataset.table); return; }
    const bk = t.closest("[data-bulk-to]");
    if (bk) { bk.disabled = true; await bulk(bk.dataset.table, bk.dataset.bulkTo); return; }
    const more = t.closest("[data-more]"); if (more) { tables[more.dataset.more].shown += PAGE; redraw(more.dataset.more); return; }
    const clip = t.closest(".clip"); if (clip) { clip.classList.toggle("open"); return; }
    const nav = t.closest("[data-screen]"); if (nav) { screen = nav.dataset.screen; location.hash = screen; renderNav(); renderPortals(); return; }
    const b = t.closest("[data-tab]"); if (b) { tab = b.dataset.tab; renderApps(); return; }
    const th = t.closest("[data-sort]"); if (th) { const st = tables[th.dataset.table]; if (st.sortKey === th.dataset.sort) st.sortDir = -st.sortDir; else { st.sortKey = th.dataset.sort; st.sortDir = th.dataset.sort === "fit" || th.dataset.sort === "applied_on" ? -1 : 1; } redraw(th.dataset.table); return; }
    const mark = t.closest("[data-mark]"); if (mark) { mark.disabled = true; if (!(await save(mark, mark.dataset.mark, { status: "applied", was: mark.dataset.was }))) mark.disabled = false; return; }
    const show = t.closest("[data-show]"); if (show) { const x = items.get(show.dataset.show); const r = await post("/api/show", routed(x, { id: x.id })); const ok = r.ok && (await r.json()).ok; show.textContent = ok ? "It is in front now" : "Its window is closed"; return; }
    const set = t.closest("[data-set]"); if (set) { const x = items.get(set.dataset.set); await act("/api/status", routed(x, { id: x.id, status: set.dataset.to, was: set.dataset.was, ...(set.dataset.reason ? { reason: set.dataset.reason } : {}) }), "saved-" + set.dataset.set); return; }
    const ans = t.closest("[data-answer]");
    if (ans) {
      const box = ans.closest("[data-job]");
      const job = items.get(ans.dataset.answer);
      const answers = [...box.querySelectorAll("[data-q]")].map((el) => ({ question: job.items[Number(el.dataset.q)].question, answer: el.value.trim(), remember: !!box.querySelector('[data-keep="' + el.dataset.q + '"]').checked })).filter((a) => a.answer);
      if (!answers.length) { document.getElementById("saved-" + ans.dataset.answer).textContent = "type an answer first"; return; }
      await act("/api/answer", routed(job, { id: job.id, answers }), "saved-" + ans.dataset.answer);
      return;
    }
    const mok = t.closest("[data-mail-ok]"); if (mok) { const m = items.get(mok.dataset.mailOk); const box = mok.closest("[data-mail]"); const jobId = box.querySelector("[data-mjob]").value; if (!jobId) return; await act("/api/mail", routed(m, { id: m.id, jobId, kind: box.querySelector("[data-mkind]").value })); return; }
    const mno = t.closest("[data-mail-no]"); if (mno) { const m = items.get(mno.dataset.mailNo); await act("/api/mail", routed(m, { id: m.id })); return; }
    if (t.id === "pSave") { await act("/api/policy", { target: Number($("#pTarget").value), jevBudgetUsd: Number($("#pBudget").value), minScore: Number($("#pScore").value), where: words("pWhere"), levels: words("pLevels"), boards: words("pBoards"), excludeEmployers: words("pExclude"), documents: { tailor: $("#pTailor").checked, cover: $("#pCover").checked } }, "saved-policy"); return; }
    if (t.id === "autoPause") { await act("/api/schedule", { on: false }, "saved-auto"); return; }
    if (t.id === "autoStop") { await act("/api/stop", {}, "saved-auto"); return; }
  });
  document.addEventListener("change", (e) => { if (e.target.id === "autoOn" || (e.target.id === "autoAt" && $("#autoOn").checked)) act("/api/schedule", { on: $("#autoOn").checked, at: $("#autoAt").value }, "saved-auto"); });
  document.addEventListener("change", (e) => {
    const s = e.target.closest("select[data-id]"); if (s && s.value) save(s, s.dataset.id, { status: s.value, was: s.dataset.was });
    const n = e.target.closest("textarea[data-notes]"); if (n) save(n, n.dataset.notes, { notes: n.value });
  });
  $("#q").addEventListener("input", (e) => { q = e.target.value; renderApps(); });
  $("#qRecent").addEventListener("input", (e) => { qRecent = e.target.value; renderRecent(); });
  $("#qNeeds").addEventListener("input", (e) => { qNeeds = e.target.value; renderNeeds(); });
  // A link to /#needs from inside the page, or the browser's Back button, changes the screen too.
  window.addEventListener("hashchange", () => { const k = location.hash.replace(/^#/, ""); if (SCREENS.some(([s]) => s === k) && k !== screen) { screen = k; renderNav(); renderPortals(); } });
  async function load() {
    data = live ? await (await fetch("/api/data")).json() : JSON.parse(embedded.textContent);
    if (live) { needs = await (await fetch("/api/needs")).json(); if (!data.combined) auto = await (await fetch("/api/automation")).json(); }
    // The combined board runs nothing, so it has no Automation screen.
    if (data.combined) { SCREENS = SCREENS.filter(([k]) => k !== "auto"); if (screen === "auto") screen = "today"; }
    renderToday(); renderApps(); renderRecent(); renderNeeds(); renderAuto(); renderNav(); renderPortals();
  }
  load();
  // The live page keeps itself current, so a job posted after it was opened appears without a reload.
  // It waits while the person is typing or choosing, so a note in progress is not wiped.
  if (live) setInterval(() => { const a = document.activeElement; if (!a || !a.matches("textarea, select, input[type=text], input[type=number], input[type=search]")) load(); }, 60000);
})();
</script>
</body></html>`;
}

export const escapeForTitle = esc;
