/**
 * The combined board and the link to the portals: the four portals' records added up with each
 * row naming its portal, the shared secret, a change passed to the portal that owns the job, and a
 * portal that takes a passed change only with the secret and only on the paths its page could use.
 * Everything runs on made-up data, against stand-in portals on this machine.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as netServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { childEnv, ROOT } from "../src/config.js";
import { combineData, combineNeeds, hasLinkKey, LINK_HEADER, linkKey, type Part } from "../src/report/link.js";
import { startReportServer } from "../src/report/server.js";

const portal = (title: string, port: number) => ({ title, port, accent: "#000000" });
const data = (company: string, applied: number) => ({
  rows: [{ job_id: "same-id", company, status_key: "applied" }],
  totals: { applied, queued: 2 },
  byStatus: { Applied: applied },
  byBoard: { lever: applied },
  byDay: [{ day: "2026-10-26", applied }],
  recent: [{ id: "r1", company, found_at: `2026-10-26T0${applied}:00:00Z` }],
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = netServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

describe("the combined board's numbers", () => {
  const parts: Part[] = [
    { portal: portal("North", 1), data: data("Acme", 3) as never, needs: { questions: [{ id: "q1" }], login: { at: "x", reason: "the session expired" }, answers: [{ id: "a1" }, { id: "a2" }] }, error: "" },
    { portal: portal("South", 2), data: data("Globex", 1) as never, needs: { questions: [{ id: "q1" }], login: null }, error: "" },
    { portal: portal("East", 3), data: null, needs: null, error: "answered 500" },
  ];

  it("adds the portals up, and every row names the portal it came from", () => {
    const c = combineData(parts, new Date("2026-10-27T00:00:00Z"));
    expect(c.totals).toEqual({ applied: 4, queued: 4 });
    expect(c.byDay).toEqual([{ day: "2026-10-26", applied: 4 }]);
    // The same job id in two portals stays two rows, told apart by their port.
    expect(c.rows.map((r) => [r.company, r.portal, r.port])).toEqual([["Acme", "North", 1], ["Globex", "South", 2]]);
    expect(c.recent.map((r) => r.company)).toEqual(["Acme", "Globex"]);
    expect(c.portals.map((p) => [p.title, p.ok, p.error])).toEqual([["North", true, ""], ["South", true, ""], ["East", false, "answered 500"]]);
  });

  it("names what waits on a portal's own page instead of dropping it", () => {
    const n = combineNeeds(parts);
    expect(n.questions).toEqual([{ id: "q1", portal: "North", port: 1 }, { id: "q1", portal: "South", port: 2 }]);
    expect(n.elsewhere).toEqual([
      { portal: "North", port: 1, text: "login needs you: the session expired" },
      { portal: "North", port: 1, text: "2 answers waiting" },
    ]);
  });
});

describe("the shared secret", () => {
  it("is made once, readable by this user only, and checked in full", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-link-"));
    const file = path.join(dir, "state", "report-link.key");
    const key = linkKey(file);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(linkKey(file)).toBe(key);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(hasLinkKey({ headers: { [LINK_HEADER]: key } }, key)).toBe(true);
    expect(hasLinkKey({ headers: { [LINK_HEADER]: key.slice(1) } }, key)).toBe(false);
    expect(hasLinkKey({ headers: {} }, key)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a change passed between dashboards", () => {
  let shared = "";
  let stand: Server;
  let standPort = 0;
  const got: { path: string; link: string; token: string; body: unknown }[] = [];
  const env = { role: process.env.JEV_ROLE, shared: process.env.JEV_SHARED_DIR };

  beforeAll(async () => {
    shared = mkdtempSync(path.join(tmpdir(), "jev-shared-"));
    process.env.JEV_SHARED_DIR = shared;
    // A stand-in portal: answers what a portal's dashboard answers, and keeps what it is sent.
    stand = createServer((req, res) => {
      if (req.method === "GET") {
        const body = req.url === "/api/data" ? data("Initech", 2) : { questions: [], waiting: [], unconfirmed: [], self: [{ id: "s1", company: "Initech" }], mail: [] };
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      }
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        got.push({ path: req.url ?? "", link: String(req.headers[LINK_HEADER] ?? ""), token: String(req.headers["x-jev-token"] ?? ""), body: JSON.parse(raw) });
        res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "Initech changed since this page was loaded" }));
      });
    });
    await new Promise<void>((r) => stand.listen(0, "127.0.0.1", r));
    standPort = (stand.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => stand.close(() => r()));
    for (const [k, v] of [["JEV_ROLE", env.role], ["JEV_SHARED_DIR", env.shared]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(shared, { recursive: true, force: true });
  });

  it("the combined board reads the portals and sends a change to the one that owns the job, with the secret", async () => {
    process.env.JEV_ROLE = "combined";
    const port = await freePort();
    const origin = await startReportServer(port, { portals: [portal("Stand-in", standPort)] });
    delete process.env.JEV_ROLE;
    const page = await (await fetch(origin)).text();
    const token = /const TOKEN = "([0-9a-f]+)"/.exec(page)?.[1] ?? "";
    const combined = (await (await fetch(`${origin}/api/data`)).json()) as { combined: boolean; rows: { company: string; port: number }[] };
    expect(combined.combined).toBe(true);
    expect(combined.rows).toEqual([{ job_id: "same-id", company: "Initech", status_key: "applied", portal: "Stand-in", port: standPort }]);
    expect(((await (await fetch(`${origin}/api/needs`)).json()) as { self: unknown[] }).self).toEqual([{ id: "s1", company: "Initech", portal: "Stand-in", port: standPort }]);
    expect((await fetch(`${origin}/api/automation`)).status).toBe(404);

    const send = (p: string, body: unknown) => fetch(origin + p, { method: "POST", headers: { "content-type": "application/json", "x-jev-token": token }, body: JSON.stringify(body) });
    const res = await send("/api/status", { port: standPort, id: "s1", status: "applied", was: "needs_review" });
    // The portal's answer comes back as it gave it, refusal included.
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Initech changed since this page was loaded" });
    expect(got).toEqual([{ path: "/api/status", link: linkKey(), token: "", body: { id: "s1", status: "applied", was: "needs_review" } }]);
    // A portal it does not read, a change with no portal, and a portal's daily rules are refused here.
    expect((await send("/api/status", { port: 1, id: "s1" })).status).toBe(400);
    expect((await send("/api/status", { id: "s1" })).status).toBe(400);
    expect((await send("/api/policy", { port: standPort, target: 3 })).status).toBe(400);
    expect(got).toHaveLength(1);
  });

  it("a portal takes a passed change only with the secret, and never for its daily rules", async () => {
    const port = await freePort();
    const origin = await startReportServer(port);
    const send = (p: string, headers: Record<string, string>) => fetch(origin + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    // An empty change is refused by its schema, which shows the secret got it past the door; nothing is written.
    expect((await send("/api/status", { [LINK_HEADER]: linkKey() })).status).toBe(400);
    expect((await send("/api/status", { [LINK_HEADER]: "0".repeat(64) })).status).toBe(403);
    expect((await send("/api/status", {})).status).toBe(403);
    expect((await send("/api/policy", { [LINK_HEADER]: linkKey() })).status).toBe(403);
    expect((await send("/api/schedule", { [LINK_HEADER]: linkKey() })).status).toBe(403);
  });
});

describe("the combined board's folder", () => {
  it("runs no search, apply or schedule, only the dashboard and doctor", () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, "bin", "jev.js"), ...args], { cwd: ROOT, encoding: "utf8", env: { ...childEnv(), JEV_ROLE: "combined" } });
    for (const cmd of [["discover"], ["apply", "--dry"], ["hourly"], ["daily", "--dry"], ["schedule", "status"]]) {
      const r = run(...cmd);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(new RegExp(`combined board.*"${cmd[0]}" is not run here`));
    }
    expect(run("report", "--help").status).toBe(0);
  }, 60_000);
});
