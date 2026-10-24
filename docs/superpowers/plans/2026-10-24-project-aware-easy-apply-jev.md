# Project-aware Easy Apply — JEV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point JEV at the local LinkedIn MCP fork, send LinkedIn Easy Apply jobs to it, record the outcome with the same guarantees the Chrome path has, and surface model-answered questions on **Needs you** so confirming one writes it to `profile.answers`.

**Architecture:** The listing lookup already asks the LinkedIn MCP about each posting; it now keeps the apply type it was throwing away and marks Easy Apply jobs applyable even though Chrome cannot fill them. The pipeline partitions those entries, records `submission_unknown` before calling `apply_to_job`, maps the result onto queue statuses, and files any learned answers in a small pending store the dashboard reads.

**Tech Stack:** TypeScript strict ESM, Node 22, zod, vitest, `tsx`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-24-project-aware-easy-apply-design.md`

## Global Constraints

- Two runtime dependencies stay two. Every external payload is parsed with zod before use.
- The MCP child is started with `childEnv()`; no key is ever added to it.
- Every record is written through `writeAtomic` / `mutateQueue` / `updateEntry` under the store lock.
- `--dry` never calls `apply_to_job`.
- A job is never sent twice: `submission_unknown` before the call, and no retry without reading the posting.
- Plain prose, no em dashes, no AI attribution trailers in commits.
- Tests are offline; fixtures carry no personal data.

## Review Focus

- **A cache file written before this change.** Entries have no `applyType`. It must load, stay non-applyable, and not throw. Pinned by `test_an_old_cache_entry_loads_without_an_apply_type`.
- **A call that times out after the MCP clicked Submit.** The job must be `submission_unknown` and must not be re-sent on the next run. Pinned by `test_a_timed_out_call_leaves_the_job_submission_unknown`.
- **A rehearsal.** `--dry` must never call the MCP, even for an Easy Apply job. Pinned by `test_a_rehearsal_never_calls_the_apply_tool`.
- **An external LinkedIn posting.** It must keep the Chrome path, unchanged. Pinned by `test_an_external_posting_is_not_routed_to_the_mcp`.
- **A learned answer with no matching option.** Confirming it must still store it, and the next run must not reuse it as a radio value. Pinned by `test_a_confirmed_answer_with_no_option_is_stored_but_not_forced_onto_a_radio`.

---

### Task 1: Start the fork, and name the tool per call

**Files:**
- Modify: `src/config.ts` (`MCP`)
- Modify: `src/mcp/client.ts` (`start` options gain `cwd`)
- Modify: `src/sources/listingLink.ts` (`ToolCall`, `mcpCaller`, `resolveListings`)
- Test: `tests/mcpClient.test.ts` (create if absent)

**Interfaces:**
- Produces: `McpServer = { command: string; args: readonly string[] }` unchanged; `McpClient.start(server, { startupMs, name?, cwd? })`; `ToolCall = (board: Board, tool: string, args: Record<string, unknown>) => Promise<string>`.
- `MCP.linkedin = { command: "uv", args: ["run", "--directory", "/home/ohmz/StudioProjects/linkedin-mcp-server", "-m", "linkedin_mcp_server"], tools: { read: "get_job_apply_url", apply: "apply_to_job" } }`
- `MCP.indeed.tools = { read: "indeed_get_job_detail" }`

- [ ] **Step 1: Write the failing tests**

```ts
it("starts a server in the folder it is given", async () => {
  // spawn is injected or spied; assert the options carry cwd: ROOT
});

it("calls the tool it is given, not a fixed one", async () => {
  // a Caller from mcpCaller with a stubbed client; assert callTool received "apply_to_job"
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/mcpClient.test.ts`
Expected: FAIL, `cwd` not accepted / `MCP.linkedin.tool` undefined

- [ ] **Step 3: Implement**

Add `cwd?: string` to `McpClient.start`'s options and pass it to `spawn`. In `mcpCaller`, `call(board, tool, args)` uses the tool argument; `resolveListings` passes `MCP[board].tools.read`. `mcpCaller` passes `cwd: ROOT` to `McpClient.start`, so every board server starts in the variant's folder.

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run tests/mcpClient.test.ts && npx tsc --noEmit`
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/mcp/client.ts src/sources/listingLink.ts tests/mcpClient.test.ts
git commit -m "feat(sources): start the linkedin fork and name each tool call"
```

---

### Task 2: Keep the apply type in the listing cache

**Files:**
- Modify: `src/sources/listingLink.ts`
- Test: `tests/listingLink.test.ts`

**Interfaces:**
- Produces: `ResolvedListing = { url: string | null; applyType: string | null }`; `resolveListings(...): Promise<Map<string, ResolvedListing>>`; `applyTypeIn(text: string): string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
it("keeps easy apply as an answer with no link", async () => {
  // reply: {"apply":{"type":"easy_apply"}}
  // found.get(id) === { url: null, applyType: "easy_apply" }
});

it("an old cache entry loads without an apply type", () => {
  // write {"linkedin:123": {"url": null, "at": "..."}}
  // loadListingLinks returns applyType null, and nothing throws
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/listingLink.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`applyTypeIn` parses the reply as JSON and reads `apply.type`, returning null for anything else. The cache schema gains `applyType: z.string().nullable().default(null)`. `resolveListings` stores and returns both. Callers that only want the link read `.url`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/listingLink.test.ts`
Expected: pass

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(sources): remember how a linkedin posting takes applications"
```

---

### Task 3: Mark Easy Apply jobs applyable

**Files:**
- Modify: `src/run/followListings.ts`
- Test: `tests/followListings.test.ts`

**Interfaces:**
- Consumes: `ResolvedListing` from Task 2.
- Produces: a LinkedIn entry with `applyType === "easy_apply"` gets `applyable = true` and `holdUntil = null`, and keeps its LinkedIn URL.

- [ ] **Step 1: Write the failing tests**

```ts
it("puts an easy apply listing in the apply run with no employer link", async () => {
  // reply {"apply":{"type":"easy_apply"}}
  // a.applyable === true, a.job.url unchanged, a.holdUntil === null
});

it("an external posting is not routed to the mcp", async () => {
  // reply {"apply":{"type":"external","url":"https://boards.greenhouse.io/x/1"}}
  // job moves to the employer link and applyable follows canFill
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/followListings.test.ts`
Expected: FAIL on the first

- [ ] **Step 3: Implement**

In `followListings`, after resolving, for each held entry: if it has a `url`, move as today; else if `applyType === "easy_apply"`, set `e.applyable = true` and `e.holdUntil = null` and persist through the same `mutateQueue` block. Do not mark `applied` or `submission_unknown` entries.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/followListings.test.ts`
Expected: pass

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(sources): let easy apply listings into the apply run"
```

---

### Task 4: The MCP apply client

**Files:**
- Create: `src/sources/linkedinApply.ts`
- Create: `tests/linkedinApply.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const McpApplyStatus = z.enum(["applied","already_applied","blocked","failed","not_easy_apply","closed","external","outcome_unknown"]);
  export type Learned = { question: string; answer: string; options: string[]; required: boolean };
  export type Unanswered = { label: string; kind: string; options: string[]; required: boolean };
  export type McpApplyResult = { status: z.infer<typeof McpApplyStatus>; message: string; project?: string; learned: Learned[]; unanswered: Unanswered[] };
  export async function applyOnLinkedIn(id: string, o: { call: ToolCall; callMs?: number }): Promise<McpApplyResult>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("parses an applied result and its learned answers", async () => {
  // text content is JSON: {"status":"applied","message":"...","project":"jev-android-tx","learned":[...]}
});

it("an unreadable reply is a failure, not an application", async () => {
  // "not json" -> throws McpApplyError
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/linkedinApply.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

Call `o.call("linkedin", MCP.linkedin.tools.apply, { job_id: id })`, parse the returned text with `McpApply` (zod), defaulting `learned` and `unanswered` to `[]`. A parse failure throws `McpApplyError` carrying the first 200 characters.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/linkedinApply.test.ts`
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add src/sources/linkedinApply.ts tests/linkedinApply.test.ts
git commit -m "feat(sources): read the linkedin apply result"
```

---

### Task 5: Route Easy Apply jobs through the pipeline

**Files:**
- Modify: `src/run/pipeline.ts`
- Test: `tests/pipelineMcp.test.ts` (create)

**Interfaces:**
- Consumes: `applyOnLinkedIn`, `record`, `addLearned` (Task 6), `MCP.applyCallMs`.
- Produces: `export function isMcpApply(e: QueueEntry): boolean` — true when `e.applyable` and `listingOf(e.job.url)?.board === "linkedin"`.
- `MCP.applyCallMs = 240_000` in `src/config.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
it("records submission_unknown before it calls the apply tool", async () => {
  // the fake caller reads loadQueue() inside the call and returns that status in its reply
  expect(seenInsideCall).toBe("submission_unknown");
  expect(loadQueue(file).entries[0].status).toBe("applied");
});

it("a timed out call leaves the job submission_unknown", async () => {
  // the caller rejects with a timeout
  expect(loadQueue(file).entries[0].status).toBe("submission_unknown");
  expect(secondRunCalls).toBe(0);   // a later run does not re-send
});

it("a rehearsal never calls the apply tool", async () => {
  await pipeline(entries, { ...base, dry: true });
  expect(applyCalls).toBe(0);
});

it("an applied result is recorded and counted", async () => {
  expect(result.sent).toContain(id);
  expect(loadQueue(file).entries[0].status).toBe("applied");
});

it("a blocked result is needs_review and writes the report", async () => {
  expect(loadQueue(file).entries[0].status).toBe("needs_review");
  expect(loadReport(id).reviews.map((r) => r.label)).toEqual(["Expected salary (USD)"]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/pipelineMcp.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

In `pipeline`, after `followListings`, split `entries` into `mcp` (via `isMcpApply`) and `rest`. Keep `reports` indexed by the original `entries`. For each `mcp` entry, outside `paced` (it opens no page):

1. `record(id, "submission_unknown", "sent to the LinkedIn MCP; waiting for its answer")` unless `o.dry`.
2. `await applyOnLinkedIn(id, { call, callMs: MCP.applyCallMs })` through a caller that is closed afterwards, or a client reused for the loop.
3. Map: `applied`/`already_applied` → `record(id,"applied",...)` and push to `sent`; `blocked`/`failed`/`not_easy_apply` → `record(id,"needs_review", message)` and write a report; `closed` → `record(id,"skipped","the posting is closed")`; `outcome_unknown` → leave `submission_unknown`; an error or timeout → leave `submission_unknown`.
4. `addLearned(result.learned.map((l) => ({ jobId: id, company: entry.job.company, title: entry.job.title, question: l.question, answer: l.answer, options: l.options })))`.
5. Leave `reports[index]` undefined for these entries: the only caller reads `sent`, and there is no form to report. Do not call `printFill` for them. A blocked entry still writes a report file with `saveReport(blockedReport(id, result.message))` plus one `reviews` row per `unanswered` item, because `needs.ts` reads that file.

`o.dry` skips step 1 and the call entirely, recording nothing.

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run tests/pipelineMcp.test.ts && npx tsc --noEmit`
Expected: pass

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(jev): apply to easy apply jobs through the mcp"
```

---

### Task 6: The pending learned-answers store

**Files:**
- Create: `src/answers/learned.ts`
- Modify: `src/config.ts` (`PATHS.learned`)
- Test: `tests/learned.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type NewPending = Omit<Pending, "id" | "at">;
  export type Pending = { id: string; jobId: string; company: string; title: string; question: string; answer: string; options: string[]; at: string };
  export function loadLearned(file?: string): { pending: Pending[] };
  export function addLearned(rows: NewPending[], file?: string): number;   // deduped by question, returns how many were new
  export function confirmLearned(id: string, answer: string, files?: { pending?: string; profile?: string }): { question: string; answer: string };
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("keeps one pending entry per question", () => {
  // add the same question twice from two jobs; load returns one
});

it("confirming writes the profile and clears the entry", () => {
  // confirmLearned writes profile.answers and loadLearned no longer has it
});

it("a confirmed answer with no option is stored but not forced onto a radio", () => {
  // confirm stores it; the stored row is {question, answer} only
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/learned.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

Both writers run inside `withStore` and use `writeAtomic`. `confirmLearned` reads the pending entry, appends `{question, answer}` to `profile.answers` (replacing any entry with the same question), parses the whole profile with `ProfileSchema` before writing, then removes the pending row.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/learned.test.ts`
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add src/answers/learned.ts src/config.ts tests/learned.test.ts
git commit -m "feat(answers): keep learned answers until a person confirms them"
```

---

### Task 7: The Needs you section

**Files:**
- Modify: `src/report/needs.ts`
- Test: `tests/needs.test.ts` (extend)

**Interfaces:**
- `Needs` gains `answers: Pending[]`.

- [ ] **Step 1: Write the failing test**

```ts
it("lists a learned answer as something to confirm, once", () => {
  // addLearned two jobs with the same question; buildNeeds(...).answers has one row
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/needs.test.ts`
Expected: FAIL, `answers` undefined

- [ ] **Step 3: Implement**

`buildNeeds` reads `loadLearned()` and returns its rows. No queue entry is required.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/needs.test.ts`
Expected: pass

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(report): show answers waiting to be confirmed"
```

---

### Task 8: Confirm from the dashboard

**Files:**
- Modify: `src/report/server.ts`
- Modify: `src/report/page.ts`
- Test: `tests/reportServer.test.ts` (extend)

**Interfaces:**
- `POST /api/confirm-answer` with `{ id: string, answer: string }`, behind the existing Host/Origin/token checks, returning `{ question, answer }`.

- [ ] **Step 1: Write the failing test**

```ts
it("confirms a learned answer for the page's token only", async () => {
  // without the token: 403; with it: profile.answers contains the row and the pending entry is gone
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/reportServer.test.ts`
Expected: FAIL, 404

- [ ] **Step 3: Implement**

Add the route beside `/api/answer`, calling `confirmLearned`. Render the section on the page from `Needs.answers` with the question, the chosen answer, and the options as a hint.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/reportServer.test.ts`
Expected: pass

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(report): confirm a learned answer from the page"
```

---

### Task 9: Doctor and docs

**Files:**
- Modify: `src/doctor.ts`
- Modify: `README.md` (a short "LinkedIn Easy Apply" section)
- Test: `tests/doctor.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
it("names the fork it will start", () => {
  // the doctor row's detail contains "/linkedin-mcp-server"
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/doctor.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

The MCP check reports the configured command and directory. The README section states which jobs the MCP applies to, that JEV records `submission_unknown` before the call, and where confirmed answers go.

- [ ] **Step 4: Run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: pass

- [ ] **Step 5: Commit**

```bash
git commit -am "docs(jev): explain the linkedin easy apply path"
```
