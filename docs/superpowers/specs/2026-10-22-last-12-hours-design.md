# Last 12 hours: design

Date: 2026-10-22
Status: for approval before any code is written
Scope: `jev-job-search` and the four portal clones
(`jev-android-nj`, `jev-android-tx`, `jev-fullstack-nj`, `jev-fullstack-tx`).

## Intent

The person runs four separate portals. Each portal searches for one role family
in one area, with its own profile, resume, preferences and records. A job that
appears today is worth more than a job that has sat in the queue for a week, but
the current queue does not say which jobs are new.

This change adds:

- an hourly search in each portal, asking for posts inside the profile's short
  window (six hours in these portals, because one hour is mostly empty);
- a **Last 12 hours** page on each portal's dashboard;
- a 12-hour window per job, after which it leaves the page;
- priority in the apply order for jobs still inside that window;
- per-portal search rules, stored with that portal's profile;
- a one-time import of the person's public history from `omar-iqbal` into the
  profile.

The hourly run finds and prioritises. It never fills, submits, signs in, or
reads mail.

## What the person decided

| Question | Decision |
|---|---|
| The 12-hour clock | First seen by the tool and the posted date must both be fresh |
| What "fresh" means when the posted date is missing | Use first-seen time and mark the posted time unknown |
| What happens at 12 hours | It depends on whether the tool can fill the job |
| The hourly run's work | Find and prioritise only, no unattended applying |
| Where the hourly job runs | This Linux machine |
| The `omar-iqbal` history | Import it into the profile once |
| A job the tool can fill, after 12 hours | Leaves the page, stays queued, so `/apply` can still take it |
| A job the tool cannot fill, after 12 hours | Leaves the page and appears in **Needs you** with the employer-site note |

## The freshness rule

A queue entry is **recent** when both hold:

1. the tool first saw it less than 12 hours ago (`discoveredAt`);
2. its posted date, when it has one, is on or after the calendar date of
   `now - 12 hours` in the machine's local time.

A missing posted date does not disqualify the entry. It is shown with
"posted time unknown" and ages out 12 hours after first seen.

Why first-seen time matters: job boards return a posted date, not a time.
Indeed returns `2026-10-20`, not `2026-10-20T14:30:00Z`. The hourly search asks
inside a short window, so first-seen time is within a few hours of posting and
is the only hour-accurate timestamp every board gives. The portals start at six
hours, because a one-hour window returned almost nothing in a live check. The
posted date is still checked, because a board can resurface an old listing.

The rule lives in one place, `isRecent(entry, now)` in `src/jobs/recency.ts`, and
is used by the page, the hourly sweep and the apply ordering. It must not be
reimplemented in a second place.

## The hourly run

New command: `node bin/jev.js hourly`.
New skill: `/hourly`, with `status`, `run`, `install` and `pause`.

One run does three things, in this order:

1. **Age out.** Any queued entry the tool cannot fill that is no longer recent
   becomes `needs_review` with the reason
   `posted more than 12 hours ago; apply on the employer's site yourself`.
   Nothing else is touched. A status a person chose, a job a run owns, a sent or
   uncertain application, and a job that is still recent are left alone.
2. **Search.** Run the portal's jobspy queries for jobs posted inside the
   profile's window (six hours in these portals).
3. **Merge.** Map, filter, deduplicate and write the new finds into the queue
   and the CSV records.

The merge is additive. It never uses `writeDecided`, whose replacement shape
would drop every queued job a one-hour search did not return. A job already in
the queue keeps its link, its id, its status and its first-seen time; only the
dates and a missing description are refreshed. Keeping the first link is what
stops a job that was sent appearing again under a new id when a later run finds
a different link to it.

A run the machine missed widens the next search. The last successful run is
kept in `data/runs/hourly.json`, and the next run asks for enough hours to cover
the gap, up to a day. A run where every call failed does not advance the window.

### Search

JobSpy is run through its existing Docker image, `jobspy:latest`, not through
the MCP server, so the run needs no Claude session. The command is the same one
the MCP server uses: `docker run --rm jobspy` with `--site_name`,
`--search_term`, `--location`, `--distance`, `--results_wanted`, `--hours_old 1`,
`--country_indeed USA` and `--format json`.

The query list comes from the portal's profile, not from source:

- search terms,
- sites (Indeed and LinkedIn),
- one or more location queries with a distance,
- how many results to ask for per call,
- a cap on calls per run,
- a pause between calls to avoid bursts.

Each call is started with `childEnv()`. No key or token is passed. The JSON is
parsed with a zod schema before use. A failed call is logged and the run
continues with the other queries.

### Mapping and filtering

Raw JobSpy records are snake_case. Map them to the existing `Job` shape:

- `title`, `company`, `location`;
- `job_url_direct` when it is an http(s) link, otherwise `job_url`;
- `date_posted`: the date part goes to `postedAt`, and the full ISO timestamp,
  when the board gives one, goes to a new optional `postedAtExact`;
- `description` when the board returned one;
- `site` becomes part of `source`, for example `jobspy indeed`;
- `ats` comes from `atsFromUrl(url)`, as for every other source.

Before anything enters the queue:

- drop a title that does not match the portal's role family;
- drop a title that matches the portal's exclusion list (designers, managers,
  sales, recruiting, marketing, MDM and device management, forensics);
- drop a posting whose locations are only remote, only `USA`, or only
  `United States`, so one job cannot reach two portals;
- keep a posting when at least one location matches the portal's area list;
- deduplicate by job id, and by `company|title|location` across boards. Prefer
  the record with a direct employer link over an Indeed or LinkedIn link.

### What enters the queue

The queue entry gains two fields. `applyable: boolean` (default true) records
whether the tool can fill this posting's form. `holdUntil: string | null`
records when a held job stops waiting; a person changing the status through the
dashboard clears it, so the sweep never undoes a choice they made. It is computed from the mapped
`ats` and the account capability, with the same rules the apply loop already
uses:

- fillable: `greenhouse`, `lever`, `ashby`, `jobvite`, `rippling`, `bamboohr`,
  and `workday` when the person has an account there or allowed the tool to
  make one;
- not fillable: `linkedin`, `indeed` (whose `ats` is `other`), `icims`, `taleo`,
  `oracle`, `successfactors`, `smartrecruiters`, `amazon`, and any other board.

A fillable find goes through the code filters only, then enters as `queued`
with no fit score. It is not rated with DeepSeek: the rating model is built for
early-career postings and skips a role that asks for professional experience,
which is most of what these portals want. The hourly run is about being first,
and the place a fresh job holds in the apply order comes from its age, not its
score. The normal `/discover` rating is unchanged for the boards it reads.

A find the tool cannot fill is not rated, which saves the DeepSeek cost. It
enters as `queued` with `applyable: false` while it is recent, so the page can
show it and the hourly sweep can hand it to the person at 12 hours. If it is
already not recent when first seen, it enters as `needs_review` at once.

`discoveredAt` keeps its current meaning: the first time any search saw the job.
`entryFor` already preserves it across rediscoveries. That is what the 12-hour
window counts from.

### After 12 hours

| Kind of job | At 12 hours |
|---|---|
| Fillable, sent or being worked on | Nothing happens; the page stops showing it |
| Fillable, still queued | Stays queued; the page stops showing it |
| Fillable, skipped or below threshold | Stays as it is; the page stops showing it |
| Not fillable, queued by the hourly run | Becomes `needs_review`; appears in **Needs you** |
| Not fillable, a person already changed it | The person's status stands |

The sweep runs at the start of every hourly run. If the timer is paused or the
machine is off, held jobs stay in the queue until the next run. The page still
ages them out from view on its own.

## The dashboard page

A new screen in each portal's dashboard, named **Last 12 hours**. It sits in the
navigation next to **Today**, with a count of what it holds.

It lists every queue entry that is recent, whatever its status, so a find the
search rejected is still visible with the reason. Columns:

| Column | What it shows |
|---|---|
| Company | Name, linked to the posting |
| Role | Job title |
| Location | The posting's locations |
| Board | ATS or jobspy site |
| Posted | Posted date, or the exact time when known, or "unknown" |
| Found | How long ago the tool first saw it |
| Fit | Score when the job was rated, blank otherwise |
| Status | The current status |
| Why here | New find, posted time unknown, or the skip reason |

Order: most recently first seen at the top, then most recent posted time, then
highest fit. A short line above the table says that `/apply` takes these before
older queued jobs while they are fresh.

The page refreshes itself every 60 seconds while it is open. The live server
adds the rows to its existing data response, built from the queue. The static
snapshot (`report --static`) embeds the same rows. The dashboard's existing rules stay:
localhost only, Host and Origin checked, token for any change. The page makes
no change.

## Application priority

The apply selection and the daily selection put recent queued jobs first, then
fall back to the existing score order. The helper is
`recentFirst(entries, now)` in `src/jobs/recency.ts`, used by `pickJobs` in
`src/run/pipeline.ts` and by the daily selection in `src/run/daily.ts`.

Constraints that still apply, unchanged:

- the daily policy and the fixed daily limits;
- one application per employer per day, gaps between boards, the run cap;
- `applyable: false` entries are never picked by the tool;
- a form is still filled, read back and checked exactly as today.

Priority changes the order, never the safety rules.

## Per-portal rules

The role families and areas come from the person's established rules. They are
written into each portal's `data/profile.json` under a new optional `search`
object, because they describe this candidate and these regions. The schema is
shared; the values are not source.

| Portal | Search terms | Location queries | Accepted area | Resume |
|---|---|---|---|---|
| `jev-android-nj` | android developer, android engineer, mobile developer, mobile engineer, kotlin developer | New Jersey, New York, Philadelphia, Wilmington, Stamford | NJ, NYC metro, Philadelphia metro, Wilmington and Newark DE, Stamford, Greenwich and Norwalk CT | its own `documents/resume.pdf` |
| `jev-android-tx` | the same five | Dallas, Fort Worth, Austin, Houston, San Antonio, plus a Texas-wide query | every Texas location, including `TX, USA` and `Texas, USA` | its own resume |
| `jev-fullstack-nj` | full stack developer, fullstack developer, full stack engineer, fullstack engineer | the same five New Jersey area queries | the same NJ-close area | its own resume |
| `jev-fullstack-tx` | the same four | the same Texas queries | every Texas location | its own resume |

Shared rules for all four:

- exclude designers, managers, directors, sales, recruiting, marketing, MDM and
  device management, and forensics;
- leave out remote-only and `USA`-only postings, so one job cannot reach two
  portals;
- use the portal's own profile for work authorization, education, standing
  answers and preferences;
- use the portal's own resume, never another portal's.

The exact regexes and query list are profile data, so the person can change them
with `/profile` without a code change. The example profile shows the shape with
generic values.

## Personal history from `omar-iqbal`

One-time import, using the existing `/expand` propose-and-approve flow, extended
to accept a local repository path:

- the project write-ups in `src/content/projects/*.md`;
- the employer timeline and case studies in the Experience components;
- the open-source contributions;
- the infrastructure practice;
- facts the README states with a number or a named technology.

Each proposed fact is shown with its source. Nothing is saved without a yes.
Approved facts go into `data/profile.json` in all four portals, since it is the
same person. The profile remains the only place a form answer may come from.
The portfolio is not read live during a run.

The CV already in `documents/resume.pdf` is not replaced.

## Gmail codes

No change. The hourly run never submits, so it never needs an emailed code.
During `/apply` and `/resume`, a board's code is still read over the Gmail MCP
with the person's consent and entered with `node bin/jev.js code <id>`. The new
`/hourly` skill states that it does not read mail.

## Constraints and anti-goals

- No unattended filling or sending. The hourly run is discovery only.
- No CAPTCHA, robot check, sign-in or account creation.
- No reading or changing mail.
- No PII in source, tests, docs or commit messages. Search rules live in
  `data/profile.json`, which is git-ignored.
- No weakening of `isReady`, the submit guard, `unsupportedClaims`, or the
  resume and file-box rules.
- No second way to write the queue or a CSV: `mutateQueue`, `writeAtomic`, the
  store lock.
- No new dependency. The Docker call uses the Node standard library.
- No fetched page content is executed. JobSpy JSON is parsed with zod and
  treated as data.
- No em dashes in the new prose.

## Files and modules

New:

- `src/jobs/recency.ts`: the freshness rule, `recentFirst`, and the age-out
  sweep.
- `src/jobs/fillable.ts`: whether the apply loop can fill a posting's form.
- `src/sources/jobspy.ts`: the Docker call, the zod schema, mapping, role and
  area filters, cross-board dedupe.
- `src/run/hourly.ts`: the three steps of one run.
- `src/report/recent.ts`: the rows the page shows.
- `.claude/skills/hourly/SKILL.md`: `/hourly`.
- tests for each of the above.

Changed:

- `src/profile/schema.ts`: the optional `search` object.
- `src/jobs/normalize.ts`: optional `postedAtExact`.
- `src/jobs/queue.ts`: `applyable`, default true, preserved on rediscovery.
- `src/jobs/hardFilters.ts`: no change to the rules; the hourly importer calls
  the same `preFilter`.
- `src/run/pipeline.ts`: recent-first selection; skip `applyable: false`.
- `src/run/daily.ts`: recent-first selection.
- `src/run/schedule.ts`: an hourly schedule for Linux and macOS.
- `src/report/data.ts`, `server.ts`, `page.ts`: the new screen and its rows.
- `src/report/needs.ts`: the by-hand fallback for a `needs_review` job with no
  form report, so an aged held job actually appears in Needs you.
- `src/discover.ts`: keep `applyable` on rediscovery.
- `src/cli.ts`: `hourly`, and the hourly form of `schedule`.
- `src/config.ts`: `HOURLY` constants, no candidate data.
- `README.md`, `docs/USAGE.md`, `docs/DAILY.md`, `docs/ARCHITECTURE.md`, the
  `/report` and `/discover` skills, and `data/profile.example.json`.

## Schedule

The existing schedule writes a macOS LaunchAgent for one daily run, with a
label that is the same in every clone. Four portals would collide.

The hourly schedule gets:

- a label derived from the portal id in `profile.search.portal`, for example
  `jev-hourly-android-nj`;
- on Linux, a systemd user service and timer in
  `~/.config/systemd/user/`, with `OnCalendar=hourly` or `OnUnitActiveSec=1h`,
  started with `systemctl --user enable --now`;
- on macOS, a LaunchAgent with `StartInterval` 3600;
- a staggered minute offset per portal (0, 10, 20, 30) so four jobspy runs do
  not hit the boards at once;
- `schedule remove --hourly` and `schedule status` covering both the daily and
  hourly jobs.

Nothing is installed until the person runs the command. The install is shown in
a `bash` block first. The four timers are installed only after approval of this
design. The daily timer keeps its shared label for now, so the daily schedule
belongs to one portal at a time; the hourly timers are the four independent
ones.

## Tests

Offline, on fixtures, with no personal information:

- the freshness rule at both boundaries, with a missing posted date, an exact
  timestamp, and a date-only posted date;
- JobSpy JSON mapping, including `job_url_direct`, snake_case fields and a
  missing date;
- the role and area filters, including the remote-only and `USA`-only
  exclusions;
- cross-board dedupe in favour of the direct employer link;
- fillable and not fillable classification, including Workday with and without
  an account;
- insertion of fillable finds as queued and rated, and not fillable finds as
  held;
- the age-out sweep, and that it touches no other status;
- `pickJobs` and the daily order putting recent jobs first and skipping
  `applyable: false`;
- the Needs screen showing an aged held job and not a held job still inside its
  window;
- the page rows and the static snapshot;
- systemd unit and LaunchAgent content with an injected runner, so no real
  schedule is installed in a test;
- the child-process safety test covering the Docker spawn.

Run in every repository before pushing:

```
npx tsc --noEmit && npx vitest run && npm audit --omit=dev
```

## Rollout to the four portals

1. Implement and test in `jev-job-search`.
2. Port the same change to each portal with targeted edits. Do not copy whole
   files over the portals: their working trees already hold local changes that
   this repository does not have, including the by-hand fallback in
   `buildNeeds`. Resolve each file against what is there.
3. Add the `search` block to each portal's `data/profile.json` from the table
   above, using that portal's own resume path and preferences.
4. Run the `omar-iqbal` import, propose the facts, and write only what the
   person approves.
5. Run the hourly command with `--dry` in each portal, then one real run.
6. Open each dashboard and check the Last 12 hours page against the queue.
7. Install the four staggered timers and check `schedule status`.
8. Run the full check in every repository.

No commit or push happens unless the person asks.

## Calls I made

These are the decisions the conversation left to me. Check them while reading.

1. A find the tool cannot fill is held in the queue as `queued` with
   `applyable: false` while it is recent, then becomes `needs_review` at 12
   hours. This keeps the status truthful, keeps `/apply` away from an Indeed
   page, and gives the hourly run the move the person asked for.
2. Hourly finds are not rated with DeepSeek, because the rating model skips
   roles that ask for professional experience and would empty this person's
   fresh queue. A fresh job is ordered by its age, then the code filters decide
   whether it is queued or skipped.
3. The page shows every recent queue entry, including skipped and held ones,
   with the reason. It is a view of what was found, not only of what will be
   applied to.
4. The page follows the existing dashboard style and needs no mockup: a nav
   screen with one table and one explanatory line.
5. The hourly timer is separate from the daily timer and named per portal, so
   the four clones do not overwrite each other.
6. The `omar-iqbal` import is one-time and approved fact by fact, not a live
   read during writing, so the rule that answers come only from the profile
   stays whole.
7. Search terms, location queries and area regexes live in each portal's
   profile, not in `src/config.ts`, because they name this candidate's roles
   and regions.

## Left to the builder

- The exact markup and CSS of the new screen, within the existing dashboard
  style.
- The systemd unit details and the minute offsets.
- The query cap and pause values in `HOURLY`, tuned against real runs.
- The exact title and area regexes, which the person can tune in the profile
  without a code change.
- Whether the page's auto-refresh uses the existing load path or a smaller
  endpoint; either is acceptable if it stays localhost-only.
