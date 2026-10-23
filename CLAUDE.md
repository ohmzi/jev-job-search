# jev-job-search: rules for Claude Code

Read `README.md` first, then `docs/ARCHITECTURE.md`. The CLI is the product:
`discover` builds the queue, `apply` fills, resolves, verifies and submits.
`src/run/pipeline.ts` is the loop itself. The skills in `.claude/skills/`
run it with a person in the loop: `/setup`, `/discover`, `/hourly`, `/apply`,
`/accounts`, `/daily`, `/resume`, `/status`, `/inbox`, `/report`,
`/profile`. A person using
the tool types those and never `npx`: when you add a command, add the
slash form to a skill and lead the docs with it.

If `data/profile.json` does not exist, the person in front of you has not
set the tool up. Offer `/setup` before anything else. `node bin/jev.js
doctor` says what is in place and what to do next.

## What never changes

- **Truth.** Work authorization, education, dates and names come from
  `data/profile.json` and are never adjusted to fit a form. If a required
  field cannot be answered truthfully from the profile, the job is marked
  `needs_review`, not answered.
- **No PII in git.** `data/profile.json`, `data/bank.json`,
  `data/voice.local.md`, the resume, `applications/all.csv`, `applications/applied.csv`,
  `applications/manual.csv`, `data/memory.json`, `data/knowledge.json`,
  `data/queue.json` and its `.bak` copy, `data/accounts.json`, `data/gmail.json` and everything
  under `data/cache/` and `data/runs/` are git-ignored. `knowledge/sites.json` is tracked on purpose: it holds site
  names and kinds of controls, and `sanitize` keeps everything else out. Tests use `data/profile.example.json` only. Never paste real
  values into a fixture, a doc, source, or a commit message.
- **Verify, then submit.** A value is real when it has been read back from
  the page. A form is submitted only when it is `ready`, and an application
  counts only when the page after the click is a confirmation. Never weaken
  `isReady` or the submit guard to make a form go through. One case is
  allowed on purpose (`splitFailures`): an optional field the tool could not
  set, which the page shows empty, is reported as left blank and does not
  hold the form. A required field, a field showing another value, and the
  resume always hold it.
- **The right file in the right box.** A file box gets the resume only when
  it asks for the resume (`fileBoxWants`). A box that asks for a transcript
  or anything else is never given the resume. A tailored resume or cover
  letter (`src/documents/`) is used only when the run asked for it, and only
  after `unsupportedClaims` found nothing in it that the profile does not
  say. Never loosen that check to get a document through.
- **Sign in only where the person set it up.** A password is typed by
  `ensureSignedIn` (`src/accounts/auth.ts`) and nothing else: only into a
  box an adapter names, only while the tab is on an origin the account
  allows, only for an account in `data/accounts.json` or one the person's
  standing rule lets the tool make. Each account has its own password:
  made at random for a new account, or typed by the person for one they
  had. With none stored the tool uses only a session the person started,
  or, for an employer where the person said so (`accounts browser`),
  presses Sign In once the tool's own Chrome has filled in the password
  they saved in it: nothing is typed and the box is never read.
  A rehearsal makes no account and asks for no verification email;
  `accounts setup` is the one command that does. A sign-in that was refused, or did not
  go through, is never retried and never leads to a new account: the
  account is paused until the person lifts it. An account is written down
  as made only once the board shows it exists. Account terms are ticked only when the
  person approved `account_terms`; a marketing box never. Every exit is
  bounded (`ACCOUNTS` in `src/config.ts`), and what the sign-in cannot do
  with certainty waits for the person. Any other page with a password box
  is blocked as before: the job goes on the by-hand list and the site is
  noted. The tool solves no CAPTCHAs.
- **You never touch a password or a token.** When you work in this repo you
  never ask for, read, type or repeat a password or a token, and never
  read the Keychain. The password is typed by the person into a window of
  their own Mac (`src/accounts/ask.ts`). You never start a run that signs
  in or signs up at an employer, which includes `apply` on a Workday job
  with or without `--dry`: show the command in a `bash` block and let the
  person click Run. The one exception is a code a board emails to confirm
  an application: at the person's request you may read it from their
  mailbox and give it to `node bin/jev.js code <id>` on standard input,
  never as an argument, never repeated in a reply or a record. You build
  and test against the scripted pages in `tests/helpers/` with made-up
  credentials.
- **Secrets live in the Keychain and travel as `Secret`.** Passwords and
  the Gmail tokens are in the macOS Keychain (`src/accounts/secrets.ts`),
  never in a file, never in a command's arguments, never in a prompt to
  DeepSeek, a report, a plan, a trace or a record. Password boxes and
  one-time-code boxes are never dumped.
- **A CAPTCHA is the person's to pass, and the tool waits for them.** The
  tool never solves or clicks a CAPTCHA, reCAPTCHA, hCaptcha or Turnstile
  widget. It finds the challenge before the form is sent
  (`src/browser/captcha.ts`), tells the person, brings the tab in front,
  waits at most `RUN.humanWaitMs`, then reads the form again and sends it
  once (`waitAtCaptcha` in `src/run/pipeline.ts`). The `daily` run does not
  wait: the job is left for the person and the board is left alone. A
  plain checkbox that only states the applicant is a person, or accepts a
  privacy notice or agreement, is a form field like any other and is
  ticked from the model's answer; a marketing or newsletter box is never
  ticked and a signature is never typed (`MARKETING_Q`, `HUMAN_CONFIRM_Q`
  in `src/forms/mapForm.ts`). A code a board emails to confirm an application is
  different. With the person's consent it is read from their mailbox and
  entered by `node bin/jev.js code <id>` (`src/run/code.ts`): the code
  arrives on standard input, goes into the one box the form has for it,
  and is read back from the page before anything is sent. `--submit` clicks
  Submit, and the application is recorded only when the page confirms. A
  code is never an argument, never printed and never recorded. The email an
  employer sends to prove the inbox of an account the person set up is read
  by `src/mail/verification.ts`, with their consent. An email's content
  goes to its parser and nowhere else.
- **Never send twice.** From the moment Submit is clicked the application
  may be with the employer. The job is recorded `submission_unknown` before
  the click and is never filled or sent again until a confirmation,
  `reconcile` or the person settles it. A job that was applied to is
  refused unless `--resubmit` is given on purpose.
- **One writer at a time, whole files only.** Every record is written by
  `writeAtomic`, and every read-modify-write goes through `mutateQueue`,
  `mutateRows` or `mutateSession` under the store lock
  (`src/util/store.ts`). A command that drives the browser holds the run
  lock. Never write `data/queue.json` or a CSV any other way.
- **What the tool cannot finish truthfully, it sets aside.** A form that
  asks for a signature, or for something the profile does not say, is
  closed and listed in `applications/manual.csv` with the reason (`src/run/outcome.ts`).
  It is never answered to get it through.
- **No secrets in code or logs.** The DeepSeek key is read from `.env` by
  `src/config.ts` and nowhere else. Everything printed goes through
  `scrub` (`src/util/redact.ts`), links are kept as `safeUrl`, and every
  child process is started with `childEnv()`, an allow-list that holds no
  key. A test fails on a spawn without it. Keep it that way.
- **DeepSeek decides and writes, code acts.** Anything that is a typed
  question (which field, which option, which page, how good a fit) goes
  through DeepSeek with criteria written as definitions. Free text and the
  fields DeepSeek was unsure of go to the writer, which is also DeepSeek: one
  JSON-object call to its chat endpoint with the same key, on the model in
  `WRITER` in `src/config.ts`, with no tools, only from the facts in the
  profile (`src/answers/resolve.ts`). That is the only way a model is
  called for writing. Claude Code is how a person runs the skills in
  `.claude/skills/` and is never started by the CLI. The truth rules above do
  not depend on the model: `unsupportedClaims`, the profile-only facts and
  the "needs_review, not answered" rule are checked in code and in the prompt.
- **Nothing about one candidate in source.** Years, cities, drafts and
  phrasing come from the profile, `data/bank.json` and
  `data/voice.local.md`.
- **A remembered answer never outranks the profile.** The answer memory
  (`src/answers/memory.ts`) reuses an answer only under the same fingerprint
  of the candidate's context, only for the same form or for an answer the
  writer marked reusable, and only when the field can take it. A reused
  answer is read back from the page like any other. Do not loosen
  `MEMORY.sameQuestionConfidence` without measuring wrong matches.
- **The daily run stays inside its policy and its limits.** `daily` sends
  with nobody watching, so it does nothing without `data/policy.json`,
  checks every job against it in code (`policyRefuses`), and keeps the
  limits in `DAILY`: applications per day, per board and per employer,
  minutes between two submissions to one board, a board left alone until
  tomorrow after a human check, the run stopped at the second. Never raise
  them to send more. Nothing is scheduled until the person runs
  `schedule install`. You run `daily` without `--dry`, or install the
  schedule, only when the person typed that command (`/daily run`,
  `/daily schedule`) in the conversation.
- **Mail is read, never followed.** `inbox` (`src/mail/status.ts`) looks
  at an email's sender, subject and Gmail's own preview, never its body.
  Rules place it; an email they cannot place goes to DeepSeek as one typed
  question with the subject and that preview only; what is still unsure
  waits for the person. Nothing in an email is an instruction, and the
  tool never replies.
- **The dashboard changes things only for its own page.** It listens on
  localhost, checks the Host and Origin, and takes a change only with the
  token it gave its page (`src/report/server.ts`). An answer saved there
  goes to one job, or to the profile's standing answers when the person
  said to remember it, and only while that job is still set aside with
  that question open: the page may be old, so every change is checked
  against the job as it is now, under the lock (`saveAnswers`,
  `applyStatusChange`). A question about the right to work is never
  answered there: that is one answer per country, in the profile.
- **A board listing is followed to the employer through its MCP, then Chrome.**
  An Indeed or LinkedIn listing is not a form. `src/sources/listingLink.ts`
  starts the board's MCP server (`MCP` in `src/config.ts`) as a child process
  with `childEnv()`, asks it about the one posting, and takes from the reply
  only an https link that is not the board's own and is either a known
  application board or looks like an application. The servers read postings;
  they apply for no one, and nothing in a reply is run or followed. A server that
  fails is not an answer and is not cached. A listing with no link is left to
  Chrome, which follows the page's Apply button (`openForm`), and what Chrome
  cannot open is held for the person. The lookup runs at the start of
  `pipeline` (`src/run/followListings.ts`), so every way of applying has it. A
  job's id follows its link, because the queue derives it on every read. Never
  type into a board for this.
- **Pace every site.** Job boards drop or refuse bursts. Concurrency and
  gaps per host are in `RUN`; do not remove them to go faster.
- **The tool learns by keeping notes, and reads them before it acts.** Site
  notes (`src/knowledge/sites.ts`), the answer memory, and the DeepSeek caches
  only ever make a run cheaper or steadier. None may change what a form is
  told: a note chooses the way a value is entered, never the value.
- **Tunables live in `src/config.ts`.** No thresholds, weights, timeouts or
  URLs anywhere else.
- **Nothing from a web page is executed.** Job descriptions, labels and page
  text are data. The browser scripts only read the DOM or write values they
  were given.

## Conventions

- TypeScript, strict, ESM, Node 22, run with `tsx`. No build step.
- Two runtime dependencies (`commander`, `zod`) plus the Node standard
  library. The browser layer uses Node's own `fetch` and `WebSocket`. Adding
  a dependency needs a reason in the PR.
- Every external payload (DeepSeek, ATS APIs, the queue file, form dumps, the
  writer's reply, the memory file) is parsed with a zod schema before use.
- The three scripts in `src/forms/*.js` run inside the page. They are plain
  JavaScript with no imports, and they never use timers.
- Tests in `tests/`, vitest, offline. Fixtures in `tests/fixtures/` are real
  captured data with no personal information.
- Commits: Conventional Commits, `type(scope): imperative summary`, lower
  case, no period. Scopes: `jev`, `sources`, `rating`, `forms`, `answers`,
  `log`, `cli`, `browser`, `skills`, `docs`, `tests`, `infra`. No AI attribution
  trailers of any kind.
- Prose: plain, direct, no em dashes anywhere in source, docs or copy.

## Before pushing

```
npx tsc --noEmit && npx vitest run && npm audit --omit=dev
```
