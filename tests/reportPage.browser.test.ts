/**
 * The dashboard page in a real Chrome, against a stand-in server with made-up records. It proves
 * the page draws its four screens, sends an answer with the token it was given, and offers
 * "remember" only for a question that may be kept. Skipped where Chrome is not installed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as netServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Page, sleep, type Target } from "../src/browser/cdp.js";
import { BROWSER, childEnv, DAILY } from "../src/config.js";
import { emptyRow, type Row } from "../src/log/csv.js";
import { buildReport } from "../src/report/data.js";
import type { Needs } from "../src/report/needs.js";
import { reportPage } from "../src/report/page.js";
import { Policy } from "../src/run/policy.js";

const TOKEN = "made-up-token-for-the-test";
const row = (over: Partial<Row>): Row => ({ ...emptyRow(), Company: "Acme", "Role / Title": "Intern", "Job Link": "https://jobs.example.com/x", ATS: "ashby", ...over });
const rows = [
  row({ "Job ID": "a1", Company: "Acme", "App. Status": "Applied", "Applied On": "2026-10-02" }),
  row({ "Job ID": "l1", Company: "Vandelay", "App. Status": "Needs you", "Skip Reason": "asks for a signature", "Fit Score": "0.71" }),
  row({ "Job ID": "l2", Company: "Wonka", "App. Status": "Blocked: a sign-in page", "Fit Score": "0.52" }),
  row({ "Job ID": "l3", Company: "Kramerica", "App. Status": "Needs you", "Skip Reason": "kept in the record only" }),
];
const needs: Needs = {
  waiting: [{ id: "w1", company: "Globex", title: "Software Intern", todo: "type the code the board emailed you, then click Submit", reason: "the board emailed you a code", mail: "https://mail.google.com/mail/u/0/#search/greenhouse", open: true }],
  questions: [
    {
      id: "q1",
      company: "Acme",
      title: "Backend Intern",
      link: "https://jobs.example.com/acme/1",
      reason: "empty: Which team interests you most?",
      items: [
        { question: "Which team interests you most?", kind: "ask", options: ["Payments", "Platform"], canRemember: true, note: "" },
        { question: "Are you legally authorized to work in the United States?", kind: "profile", options: [], canRemember: false, note: "Your profile does not say this for the job's country." },
      ],
    },
  ],
  unconfirmed: [{ id: "u1", company: "Initech", title: "New Grad Engineer", link: "https://jobs.example.com/initech/2" }],
  self: [{ id: "s1", company: "Umbrella", title: "Platform Engineer", link: "https://jobs.example.com/umbrella/3", reason: "jobspy indeed listing: this board is not one the tool fills" }],
  answers: [],
  login: null,
  mail: [{ id: "m1", from: "Hooli Careers", subject: "An update on your application", on: "2026-10-03", kind: null, why: "the tool could not tell what it says", jobs: [{ id: "h1", company: "Hooli", title: "SWE Intern" }] }],
};
const automation = { running: true, stopAsked: false, policy: null, policyError: "", defaults: Policy.parse({}), limits: { maxTarget: DAILY.maxTarget, perBoard: DAILY.perBoard, perEmployerPerDay: DAILY.perEmployerPerDay, gapMinutes: [3, 6], maxMinutes: DAILY.maxMinutes }, schedule: { on: false, at: "09:00", next: null }, timezone: "America/Vancouver", today: [] };

describe.skipIf(!existsSync(BROWSER.chromePath))("the dashboard page in a real browser", () => {
  let chrome: ChildProcess;
  let server: Server;
  let origin = "";
  let port = 0;
  let profile = "";
  const posts: { path: string; token: string; body: unknown }[] = [];
  let combined = false;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const send = (body: string, type = "application/json") => res.writeHead(200, { "content-type": type }).end(body);
      if (req.method === "POST") {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString()));
        req.on("end", () => {
          posts.push({ path: req.url ?? "", token: String(req.headers["x-jev-token"] ?? ""), body: JSON.parse(raw) });
          send(JSON.stringify({ ok: true }));
        });
        return;
      }
      if (req.url === "/") return send(reportPage(null, TOKEN, 7423), "text/html; charset=utf-8");
      if (req.url === "/api/data") {
        const r = buildReport(rows, new Date(), [], new Set(["a1", "l1", "l2"]));
        // The combined board's answer: the same records, each row naming the portal it came from.
        if (combined) return send(JSON.stringify({ ...r, combined: true, portals: [{ title: "Android · NJ", port: 7421, accent: "#0d9488", ok: true, error: "" }, { title: "Android · TX", port: 7422, accent: "#7c3aed", ok: false, error: "answered 500" }], rows: r.rows.map((x) => ({ ...x, portal: "Android · NJ", port: 7421 })), run: null }));
        return send(JSON.stringify({ ...r, run: null }));
      }
      if (req.url === "/api/needs") return send(JSON.stringify(needs));
      if (req.url === "/api/automation") return send(JSON.stringify(automation));
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    port = await new Promise<number>((resolve) => {
      const s = netServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    profile = mkdtempSync(path.join(tmpdir(), "jev-chrome-"));
    chrome = spawn(BROWSER.chromePath, ["--headless=new", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore", env: childEnv() });
    for (let i = 0; i < 80; i++) {
      if (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false)) return;
      await sleep(250);
    }
    throw new Error("headless Chrome did not start");
  }, 30_000);

  afterAll(async () => {
    chrome?.kill();
    await new Promise<void>((r) => server.close(() => r()));
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  });

  it("draws its screens, and sends an answer with the token and only what was typed", async () => {
    const tab = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as Target;
    const page = await Page.attach(tab);
    const errors: string[] = [];
    page.on("Runtime.exceptionThrown", (p) => void errors.push(JSON.stringify(p).slice(0, 300)));
    await page.navigate(origin);
    for (let i = 0; i < 40 && !(await page.evaluate<boolean>("!!document.querySelector('#nav button')").catch(() => false)); i++) await sleep(150);
    expect(errors).toEqual([]);
    const nav = await page.evaluate<string[]>("[...document.querySelectorAll('#nav button')].map((b) => b.textContent)");
    expect(nav).toEqual(["Today", "Last 12 hours", "Needs you5", "Applications", "Automation"]);
    // The board says which one it is, in the page and in the tab, and links to the other four.
    expect(await page.evaluate<string>("document.querySelector('h1').textContent")).toBe("Full Stack · NJ");
    expect(await page.evaluate<string>("document.title")).toMatch(/^Full Stack · NJ/);
    expect(await page.evaluate<string[]>("[...document.querySelectorAll('#portals a')].map((a) => a.textContent)")).toHaveLength(5);
    expect(await page.evaluate<string>("document.querySelector('#portals a.on').textContent")).toBe("Full Stack · NJ");

    await page.evaluate("document.querySelector('[data-screen=needs]').click()");
    const text = await page.evaluate<string>("document.querySelector('#s-needs').innerText");
    expect(text).toMatch(/Acme needs 2 answers/);
    expect(text).toMatch(/Globex: type the code the board emailed you/);
    expect(text).toMatch(/Initech/);
    expect(text).toMatch(/An update on your application/);
    // The work-authorization question has no answer box and no "remember": it is the profile's.
    expect(await page.evaluate<number>("document.querySelectorAll('[data-job=q1] [data-q]').length")).toBe(1);
    expect(await page.evaluate<number>("document.querySelectorAll('[data-job=q1] [data-keep]').length")).toBe(1);

    await page.evaluate("(() => { const s = document.querySelector('[data-job=q1] select[data-q]'); s.value = 'Platform'; document.querySelector('[data-job=q1] [data-keep]').checked = true; document.querySelector('[data-answer=q1]').click(); })()");
    for (let i = 0; i < 30 && !posts.length; i++) await sleep(100);
    expect(posts[0]).toEqual({ path: "/api/answer", token: TOKEN, body: { id: "q1", answers: [{ question: "Which team interests you most?", answer: "Platform", remember: true }] } });

    await page.evaluate("document.querySelector('[data-screen=auto]').click()");
    const auto = await page.evaluate<string>("document.querySelector('#s-auto').innerText");
    expect(auto).toMatch(/Apply automatically/);
    expect(auto).toMatch(/Save your daily rules below first/);
    expect(auto).toMatch(/Your Mac has to be on/);
    // The switch cannot be turned on before there are rules.
    expect(await page.evaluate<boolean>("document.querySelector('#autoOn').disabled")).toBe(true);
    await page.evaluate("(() => { document.querySelector('#pTarget').value = '7'; document.querySelector('#pExclude').value = 'Acme, Globex'; document.querySelector('#pSave').click(); })()");
    for (let i = 0; i < 30 && posts.length < 2; i++) await sleep(100);
    expect(posts[1]).toMatchObject({ path: "/api/policy", token: TOKEN, body: { target: 7, excludeEmployers: ["Acme", "Globex"], where: [], documents: { tailor: false, cover: false } } });
    expect(Policy.safeParse(posts[1]?.body).success).toBe(true);
    // The answer button says what it does: nothing is sent now.
    expect(text).toMatch(/Save for next run/);
    expect(text).not.toMatch(/and continue/);
    // A run that is working can be asked to stop, apart from pausing the schedule.
    expect(auto).toMatch(/A run is working now/);
    expect(auto).toMatch(/JEV and the writer/);
    await page.evaluate("document.querySelector('#autoStop').click()");
    for (let i = 0; i < 30 && posts.length < 3; i++) await sleep(100);
    expect(posts[2]).toMatchObject({ path: "/api/stop", token: TOKEN });
    // A status set from the page carries the status the page was showing.
    await page.evaluate("(() => { document.querySelector('[data-screen=needs]').click(); document.querySelector('[data-set=u1][data-to=applied]').click(); })()");
    for (let i = 0; i < 30 && posts.length < 4; i++) await sleep(100);
    expect(posts[3]).toEqual({ path: "/api/status", token: TOKEN, body: { id: "u1", status: "applied", was: "submission_unknown" } });
    // A job the tool cannot fill has its own place, with "I applied" and "Not applying".
    expect(text).toMatch(/Apply on the employer.s site/);
    // Needs you has a filter too; the count on the tab stays the whole number.
    await page.evaluate("(() => { const q = document.querySelector('#qNeeds'); q.value = 'umbrella'; q.dispatchEvent(new Event('input')); })()");
    expect(await page.evaluate<number>("document.querySelectorAll('#needs .item').length")).toBe(1);
    expect(await page.evaluate<string>("document.querySelector('#countNeeds').textContent")).toBe("1 of 5");
    await page.evaluate("(() => { const q = document.querySelector('#qNeeds'); q.value = ''; q.dispatchEvent(new Event('input')); })()");
    await page.evaluate("document.querySelector('[data-set=s1][data-to=skipped]').click()");
    for (let i = 0; i < 30 && posts.length < 5; i++) await sleep(100);
    expect(posts[4]).toEqual({ path: "/api/status", token: TOKEN, body: { id: "s1", status: "skipped", was: "needs_review", reason: "you chose not to apply" } });

    // Left for you: each job can be marked applied from its row, or several at once.
    await page.evaluate("(() => { document.querySelector('[data-screen=apps]').click(); document.querySelector('[data-tab=manual]').click(); })()");
    const heads = await page.evaluate<string[]>("[...document.querySelectorAll('#apps th')].map((t) => t.textContent.replace(/[▲▼]/g, '').trim())");
    expect(heads).toEqual(["", "Job", "Board", "Easy Apply", "Fit", "Status", "Reason", "Notes", ""]);
    expect(await page.evaluate<string[]>("[...document.querySelectorAll('#apps tbody tr')].map((tr) => tr.children[2].textContent)")).toEqual(["ashby", "ashby", "ashby"]);
    // The filter narrows the tab by anything a row shows.
    await page.evaluate("(() => { const q = document.querySelector('#q'); q.value = 'wonka'; q.dispatchEvent(new Event('input')); })()");
    expect(await page.evaluate<number>("document.querySelectorAll('#apps tbody tr').length")).toBe(1);
    await page.evaluate("(() => { const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input')); })()");
    // The page never scrolls sideways: on a narrow screen the table scrolls in its own frame.
    expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true);
    // Best fit first, and a row the queue does not hold can be read but not changed.
    expect(await page.evaluate<string[]>("[...document.querySelectorAll('#apps .meta')].map((m) => m.textContent.split(' · ')[0])")).toEqual(["Vandelay", "Wonka", "Kramerica"]);
    expect(await page.evaluate<number>("document.querySelectorAll('#apps [data-mark]').length")).toBe(2);
    await page.evaluate("document.querySelector('#apps [data-mark=l1]').click()");
    for (let i = 0; i < 30 && posts.length < 6; i++) await sleep(100);
    expect(posts[5]).toEqual({ path: "/api/status", token: TOKEN, body: { id: "l1", status: "applied", was: "needs_review" } });
    for (let i = 0; i < 30 && !(await page.evaluate<boolean>("!!document.querySelector('#apps [data-all]')")); i++) await sleep(100);
    await page.evaluate("document.querySelector('#apps [data-all]').click()");
    await page.evaluate("document.querySelector('#apps [data-bulk-to=applied]').click()");
    for (let i = 0; i < 30 && posts.length < 8; i++) await sleep(100);
    expect(posts.slice(6).map((p) => p.body)).toEqual([
      { id: "l1", status: "applied", was: "needs_review" },
      { id: "l2", status: "applied", was: "blocked" },
    ]);
    expect(errors).toEqual([]);
    page.close();
  }, 60_000);

  it("on the combined board, names each row's portal and sends a change with it", async () => {
    combined = true;
    const tab = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as Target;
    const page = await Page.attach(tab);
    const errors: string[] = [];
    page.on("Runtime.exceptionThrown", (p) => void errors.push(JSON.stringify(p).slice(0, 300)));
    await page.navigate(origin + "/#apps");
    for (let i = 0; i < 40 && !(await page.evaluate<boolean>("!!document.querySelector('#apps tbody tr')").catch(() => false)); i++) await sleep(150);
    // It runs nothing, so it has no Automation screen; a portal that does not answer is said so.
    expect(await page.evaluate<string[]>("[...document.querySelectorAll('#nav button')].map((b) => b.textContent)")).not.toContain("Automation");
    expect(await page.evaluate<string>("document.querySelector('#portalState').textContent")).toMatch(/Android · TX is not answering/);
    await page.evaluate("document.querySelector('[data-tab=manual]').click()");
    expect(await page.evaluate<string[]>("[...document.querySelectorAll('#apps th')].map((t) => t.textContent.replace(/[▲▼]/g, '').trim())")).toEqual(["", "Job", "Portal", "Board", "Easy Apply", "Fit", "Status", "Reason", "Notes", ""]);
    const before = posts.length;
    await page.evaluate("document.querySelector('#apps [data-mark=\"7421:l1\"]').click()");
    for (let i = 0; i < 30 && posts.length === before; i++) await sleep(100);
    expect(posts[before]).toEqual({ path: "/api/status", token: TOKEN, body: { id: "l1", status: "applied", was: "needs_review", port: 7421 } });
    expect(errors).toEqual([]);
    combined = false;
    page.close();
  }, 60_000);
});
