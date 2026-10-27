---
name: hourly
description: The hourly search, the apply pass and the Last 12 hours page. Use when the user says /hourly, "find jobs every hour", "apply to the new jobs", "what is new today", "show the last 12 hours", or asks about the hourly timer or why a new job is on that page. Finds jobs, applies to the fillable ones, holds board-only listings for the person, and moves them to Needs you after twelve hours.
argument-hint: "[run | dry | status | install | pause]"
model: claude-sonnet-5-5
effort: medium
---

# /hourly

The user types a short command; you run the tool for them. They should never
have to type `npx`. The search itself is read-only. When the portal's profile
has `search.apply` and a `data/policy.json`, the same run also applies to a few
fresh jobs whose links are forms the tool can fill. It never signs in, makes an
account or reads mail. A robot check gets the tool's own one attempt; what it
cannot pass is left for the person.

## What the user can type

| They type | You do |
|---|---|
| `/hourly` | Run `node bin/jev.js schedule status --hourly`. Say whether the timer is on, at which minute, and how many jobs are on the Last 12 hours page (`node bin/jev.js hourly --json` when they want the count without spending a search; it does search, so prefer `/report` first). |
| `/hourly run` | `node bin/jev.js hourly`. They typed it, so that is their go for one search and, if the policy allows, the apply pass. Read the counts back, including what was applied and what was left. |
| `/hourly dry` | `node bin/jev.js hourly --dry`. It searches the boards, writes nothing and sends nothing. Say what it would have added and applied. |
| `/hourly install` | `node bin/jev.js schedule install --hourly`. Say the minute it runs at, and that the machine has to be on and signed in. On Linux this is a systemd user timer; on macOS a LaunchAgent. |
| `/hourly pause` | `node bin/jev.js schedule remove --hourly`. No further hourly run starts. A run already working carries on. |
| `/hourly status` | `node bin/jev.js schedule status --hourly`. |

Read the portal's name from `data/profile.json` at `search.portal`. If that
block is missing, the hourly search has no roles or places to ask for. Say so
and offer `/profile` before running anything.

## What the page shows

`/report` has a screen called **Last 12 hours**. It lists every job the tool
first saw in the last twelve hours that has not been applied to, with the
posted time, how long ago it was found, the fit when there is one, and why it
is there.

- **Where the jobs come from.** Indeed and LinkedIn through JobSpy, and the
  employers' own boards (Greenhouse, Lever, Ashby, Workable, Workday sites)
  with freehire naming new ones. Each hour reads a third of the boards, so
  every board is read once in three hours. From a board only what went up
  since its last read is taken: by the board's own time, or, for a board
  that gives only a date, a posting the last scan did not show. The first scan after a
  change only notes what is open. Intern and new-grad titles are never kept.
- **A job the tool can fill** is queued. `/apply` takes these before older
  queued jobs while they are fresh. After twelve hours it leaves the page and
  stays in the queue.
- **A board-only listing** (Indeed, LinkedIn and the like) is first followed to
  the employer: the board's MCP server is asked for the posting's apply link, and
  a link found makes it a job the tool can fill. With no link it waits on the page
  for twelve hours, is opened in Chrome when its turn comes (the page's Apply
  button is followed), and moves to **Needs you** with "apply on the employer's
  site" if nothing fills it.

Tick one job, or the header box for all of them, then **Mark selected
applied**. Each is recorded as applied, leaves the list, and is never shown
there again. The page refreshes itself every minute while it is open.

## The apply pass

When `search.apply` is true and `data/policy.json` exists, one run also applies
to fresh jobs. Fillable links go first: Greenhouse, Lever, Ashby, Jobvite,
Rippling, BambooHR, Workable, JazzHR, and Workday with an account. A board-only
page is opened and tried too.

- At most two per portal per hour, one role per employer, inside the daily
  policy: the target, the per-board and per-employer counts, the employer's open
  forms, board pauses and submission gaps.
- A fresh job is admitted without a fit score. The portal's role and area
  filters were its gate.
- Two attempts per job. After the second, it becomes `needs_review` with "left
  for you after two attempts" and is never picked again. A code, sign-in, robot
  check, signature or unconfirmed click is left for the person on the first
  attempt and never retried.
- The four portals share one Chrome, so a global lock lets only one apply at a
  time. A portal that finds the lock held skips its apply pass that hour.
- A shared registry records every confirmed application by company and title. A
  job sent from one portal is marked applied in the others and is not sent
  again, including from a manual `/apply`.
- A board-only page is tried, not skipped. If it wants a sign-in, the tool
  brings the window to the front, notifies the person and waits up to two
  minutes. If they sign in, it fills and continues; if not, the job is skipped,
  the tab stays open in Needs you and the pass moves on. A robot check or an
  emailed code after Submit gets the same two minutes (`RUN.humanWaitMs`); a
  robot check the person passes is read again and sent once. A page with no form is left open in front too.
- Most of what the hourly search finds is board-only, so many passes end with a
  window waiting for the person rather than an application sent.

## What you never do

- **Never install or remove the timer unless the user typed that command**
  (`/hourly install`, `/hourly pause`) in this conversation.
- **Never type a password, make an account or read mail** as part of the
  hourly run, and never solve a picture or puzzle challenge or press a widget
  twice. The run itself makes the one checkbox attempt; what is left is for the
  person. It ticks an "I agree" consent box on the application form, never a
  marketing or job-alert box, and leaves a criminal, background, credit or
  waiver agreement to the person. It may open a sign-in page, put it in front and
  wait for the person; they sign in themselves. A code, sign-in or challenge is
  left for them. The hourly run may fill and send a fresh job, because the
  person turned `/hourly install` on and wrote the policy.
- **Never raise a `DAILY` or `HOURLY` limit to send more.** The hourly pass
  respects the policy and stops after two attempts per job.
- If the permission system declines a command, show it in a `bash` block and let
  them click Run.

## Per-portal rules

Each portal's roles, places, exclusions, results per call, pause and minute
offset are in its own `data/profile.json` under `search`. They are not in
source. When the user wants a different role, city or exclusion, that is
`/profile`, and the next hourly run uses it.
