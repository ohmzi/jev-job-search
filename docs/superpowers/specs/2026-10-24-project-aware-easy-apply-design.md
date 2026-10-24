# Project-aware Easy Apply

Date: 2026-10-24
Status: design, awaiting approval

## Why

Four variants of this tool (`jev-android-tx`, `jev-android-nj`,
`jev-fullstack-nj`, `jev-fullstack-tx`) each apply to a different kind of
job, and each needs a different phone number and a different resume in the
LinkedIn Easy Apply wizard. Today the LinkedIn MCP server applies with
whatever the account last used, so a run under one variant can send another
variant's resume.

The wizard also asks questions the profile has no standing answer for, and
the run stops there. A person has to answer them one job at a time.

## What success looks like

One hourly run under `jev-fullstack-nj` applies with 551-320-2252 and
`Omar_Iqbal_F_N`, answers an unscripted question sensibly, sends the
application, and puts that question and answer on the variant's **Needs
you** screen. The person confirms it once; the next run under the same
variant answers the same question without asking the model.

## Goals

- The LinkedIn MCP server picks the phone number and the saved resume from
  the folder it was started in, before it submits anything.
- A wizard question with no standing answer is answered by DeepSeek from the
  variant's `data/profile.json` and its `answers[]` bank, and filled.
- Every model-answered question is returned to the caller, recorded on the
  variant's **Needs you** screen, and only becomes a standing answer once
  the person confirms it.
- JEV starts the local fork, not `uvx mcp-server-linkedin@latest`.

## Non-goals

- No change to JEV's own Chrome form flow for employer sites.
- No resume file uploads through the MCP; only the saved resumes already on
  the LinkedIn profile.
- No second apply path for Indeed.

## Anti-goals

- Never submit with a resume that is not the configured one. If the
  configured resume is not among the wizard's choices, the application is
  blocked, not sent.
- Never let the model answer a signature, a criminal/background/credit
  declaration, a salary number, an interview date, or another person's
  contact details. Those block, as they do in JEV today.
- Never put the DeepSeek key in a child process environment or in any file
  JEV writes.
- Never write `data/queue.json`, a CSV, or `data/profile.json` outside
  JEV's store lock.

## Constraints carried over

- JEV's truth rules apply to the MCP too: facts come from the variant's
  profile.
- `childEnv()` keeps keys out of children. The MCP reads
  `~/.config/deepseek/secrets.env` itself.
- Tests offline: pytest for the MCP, vitest for JEV.

## Part 1: the MCP fork

Repo: `/home/ohmz/StudioProjects/linkedin-mcp-server`.

### Identity

The server reads `os.getcwd()`, canonicalised, and walks up until the
directory name matches a known variant. Anything else is `default`. The
mapping lives in `linkedin_mcp_server/apply_profiles.json`:

```json
{
  "default": { "phone": "2148969509", "resume": "Omar_Iqbal_F_T" },
  "projects": {
    "jev-android-tx":    { "phone": "2148969509", "resume": "Omar_Iqbal_A_T" },
    "jev-android-nj":    { "phone": "5513202252", "resume": "Omar_Iqbal_A_N" },
    "jev-fullstack-nj":  { "phone": "5513202252", "resume": "Omar_Iqbal_F_N" },
    "jev-fullstack-tx":  { "phone": "2148969509", "resume": "Omar_Iqbal_F_T" }
  }
}
```

Phone numbers are matched to digits before filling. The resume value is a
stem; the wizard option contains it as a substring (`PDF
Omar_Iqbal_A_T.pdf 10/23/2026`).

### Automatic values per step

In `_walk_wizard`, after each snapshot and before the caller's `answers`:

- **Phone**: the field whose `kind` is `tel`, or whose label contains
  "phone"/"mobile" but not "country"/"code". Value: the configured digits.
- **Resume**: a radio group whose options look like resumes (each option
  ends in `.pdf`, or the group label mentions "resume"). Value: the option
  whose label contains the configured stem. No match blocks the walk.

Caller-supplied `answers` still win over both.

### Model-answered questions

Only when `<cwd>/data/profile.json` exists. Every unanswered field with a
label on the step is eligible, required or not; a field with no label is
skipped. Standing answers are tried before the model, so a confirmed answer
costs nothing:

1. Normalise the field label (lowercase, collapse whitespace, drop a
   trailing `*`).
2. Exact match against `profile.answers[].question`, then the existing
   `_match` rule (longest key that is a substring of the label,
   case-insensitive).
3. A match is used only if the control can take it: for a radio or select
   the answer must equal one of the option labels, otherwise the match is
   ignored and the field goes to the model.
4. Hard refusals still win over a standing answer.

Remaining fields go in one call per step:

- Endpoint: `POST http://127.0.0.1:8788/v1/messages` (the harness router),
  `anthropic-version: 2023-06-01`, `x-api-key` from
  `~/.config/deepseek/secrets.env` (`DEEPSEEK_API_TOKEN`), model
  `deepseek-flash[1m]`.
- Prompt: the profile (name, work authorization, address, phone, skills,
  preferences, `facts`, `answers[]`, a condensed experience list) as the
  only facts, plus each field's label, kind, required flag and options.
  Reply is one JSON object: `{"answers": [{"field": n, "value": "...",
  "why": "..."}]}`.
- Choice fields: the value must be one of the options; the closest option
  is accepted by label, else the field stays unanswered and blocks.
- Free text: typed as returned.
- After filling, the step is re-read; a field whose `filled` did not change
  counts as unanswered.

Hard-coded refusals, checked before the model is asked: signature, interview
date/time, and another person's contact details. These block the walk and
block even when a standing answer exists: they are acts, not answers.

Salary, criminal record, background check and credit check also block the
*model*, but a standing answer the person confirmed on **Needs you** is
used for them. That is their answer, not the model's invention, and it is
what makes the second run quiet.

Router unreachable or an unparseable reply: block, naming the failure.

### Result

`apply_to_job` gains two keys, and `unanswered` stops being a list of bare
labels:

```json
{
  "project": "jev-fullstack-nj",
  "learned": [
    { "question": "Do you have 5+ years of Android experience?",
      "answer": "Yes", "options": ["Yes", "No"], "required": true }
  ],
  "unanswered": [
    { "label": "Expected salary (USD)", "kind": "text",
      "options": [], "required": true }
  ]
}
```

## Decisions after review

These answer the builder check; nothing here is left to the builder.

### The phone control and the country code

Both configured numbers are US. The country-code select is left as it is
when it already reads `us`; when it does not, it is set to `us`. A contact
step with no recognisable phone field is a block: the run must not submit
the account's previous number.

### The resume control

A resume step is recognised by a radio group whose option labels name
PDFs, or by a field labelled "resume". The configured stem must appear in
one option; otherwise the walk blocks with the options it saw. A walk that
sees no resume step at all also blocks: LinkedIn has silently reused the
last resume, and not choosing it is the failure this design removes.

### Recording, and what a timeout means

JEV cannot see the instant Submit is clicked, so it records
`submission_unknown` in the queue *before* the `apply_to_job` call, under
the store lock, and moves the status when the result comes back. That is
the same guarantee the Chrome path gets from recording before its own
click.

`MCP.applyCallMs` is 240s, above the MCP's own 180s tool timeout. A
client-side timeout, a killed child, or a JSON-RPC error all leave the job
at `submission_unknown` and never retried without reading the posting,
exactly as an unconfirmed Chrome submission does today. `reconcile` gains
no MCP branch: the posting itself is the proof.

### Statuses

| MCP status | Queue record |
|---|---|
| `applied` | `applied` |
| `already_applied` | `applied` (the MCP's own words say it was already sent) |
| `blocked`, `failed`, `not_easy_apply` | `needs_review`, with the MCP's message |
| `closed` | `skipped`, reason "the posting is closed" |
| `external` | not routed here: Chrome follows it |
| `outcome_unknown` | `submission_unknown` |
| timeout / crash | `submission_unknown` |

### Eligibility

`resolveListings`' cache grows `applyType`, stored beside `url`, so the six
hour cache keeps it. `followListings` marks a LinkedIn posting with
`applyType === "easy_apply"` applyable; `external` stays as today and
`applied` is recorded as applied without a second send.

### Dry runs and counts

`--dry` never calls `apply_to_job`; a dry LinkedIn job is recorded the way
a dry Chrome job is. A real MCP submission is pushed into `pipeline`'s
`sent` array, so `DAILY` caps and the per-board gaps apply to it.

### The project table in git

`apply_profiles.json` is gitignored; `apply_profiles.example.json` is
tracked with the same four folder names and placeholder numbers, so the
fork's upstream never carries the candidate's phone number.

## Part 2: JEV

Repo: `ohmzi/jev-job-search`, branch `feat/bot-challenges`, pulled into all
four working copies.

### Pointing at the fork

`MCP.linkedin` becomes the local checkout with two tools
(`get_job_apply_url`, `apply_to_job`). `McpClient.start` passes
`cwd: ROOT` so the variant is explicit rather than inherited.

### Applying

`src/sources/listingLink.ts` today keeps only a link and drops the apply
type. It gains the type (`easy_apply`, `external`, `applied`, `closed`) in
its cache entry and returns it with the link.

New `src/sources/linkedinApply.ts`: `applyOnLinkedIn(job)` calls
`apply_to_job` with `{job_id}` and returns the parsed result.

In `pipeline`, a LinkedIn posting whose apply type is `easy_apply` goes to
the MCP instead of Chrome:

| MCP status | Queue record |
|---|---|
| `applied` | `applied`, with the MCP's message |
| `blocked` / `failed` / `not_easy_apply` | `needs_review`, with the MCP's message |
| `outcome_unknown` | `submission_unknown` |

A blocked job's questions are written as a report at
`data/runs/<jobId>.report.json` in the shape `needs.ts` already reads
(`reviews: [{id, selector, kind, label, options, why}]`), so it appears
under **Needs you** with no new screen.

### Learned answers

Applied jobs are not in `needs_review`, so their learned answers cannot
ride the existing question flow. A new store, `data/learned.json`, written
under the store lock with `writeAtomic`:

```json
{ "pending": [ {
    "id": "uuid", "jobId": "...", "company": "...", "title": "...",
    "question": "...", "answer": "...", "options": ["..."], "at": "ISO"
} ] }
```

Deduplicated by `question` across jobs.

### Confirming

The **Needs you** screen gains an "Answers to confirm" section listing each
pending entry with its question, the chosen answer, and the options. Two
actions, behind the existing Host/Origin/token checks:

- **Confirm**: append `{question, answer}` to `profile.answers` under the
  lock and drop the pending entry.
- **Change**: same, with the person's wording.

`src/answers/context.ts` already reads `profile.answers` before asking the
model, so a confirmed answer is used next run with no further change.

### Doctor

`doctor` reports the fork path and whether `apply_profiles.json` names the
folder it runs in.

## Answers to the open questions

Settled with the person:

1. A walk that sees no resume step blocks rather than sending whatever the
   account has selected.
2. A confirmed answer is reused for salary, background and credit
   declarations. Signature, interview scheduling and another person's
   contact details stay blocked regardless.

## Tests

MCP (pytest, synthetic pages as in `tests/test_job_apply_wizard_dom.py`):

- the variant is read from the starting folder; an unknown folder gets the
  default;
- the phone field is set from the table, and a step with no phone field
  blocks;
- the configured resume radio is selected;
- a missing resume blocks and submits nothing;
- a standing answer is used without calling the router;
- a standing answer that is not one of the options is not used;
- an unanswered question goes to a stubbed router and is filled;
- a refused category blocks without a router call;
- an unreachable router blocks;
- `learned` lists exactly the model-answered fields, and `unanswered`
  carries labels, kinds and options.

JEV (vitest, offline):

- a `easy_apply` listing calls `apply_to_job` and records `applied`;
- the job is `submission_unknown` while the call is in flight;
- a call timeout leaves it `submission_unknown` and a later run does not
  re-send;
- a blocked result records `needs_review` and writes the report shape
  `needs.ts` reads;
- `--dry` never calls `apply_to_job`;
- an MCP submission lands in `sent` and counts against `DAILY`;
- the listing cache keeps `applyType` across a reload;
- a learned answer appears in the built `Needs` and not twice;
- confirming writes `profile.answers` and clears the pending entry;
- the spawn carries `cwd: ROOT`;
- no key is added to `childEnv()`.

## Calls made here, for review

- The project table lives in the MCP repo as JSON, not in each variant.
- The model answers only when a `data/profile.json` exists; an unknown
  caller keeps today's behaviour.
- One model call per step, not per question.
- Learned answers are confirmed on the dashboard, not in `queue.json`.
- Blocked LinkedIn jobs reuse the existing report file so `needs.ts` needs
  no new branch.
