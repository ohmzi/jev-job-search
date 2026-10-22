---
name: hourly
description: The hourly search and the Last 12 hours page. Use when the user says /hourly, "find jobs every hour", "what is new today", "show the last 12 hours", or asks about the hourly timer or why a new job is on that page. Finds jobs, holds board-only listings for the person, and moves them to Needs you after twelve hours.
argument-hint: "[run | dry | status | install | pause]"
model: claude-sonnet-5-5
effort: medium
---

# /hourly

The user types a short command; you run the tool for them. They should never
have to type `npx`. The search is read-only: no browser, no form, no sign-in, no
mail, no sending.

## What the user can type

| They type | You do |
|---|---|
| `/hourly` | Run `node bin/jev.js schedule status --hourly`. Say whether the timer is on, at which minute, and how many jobs are on the Last 12 hours page (`node bin/jev.js hourly --json` when they want the count without spending a search; it does search, so prefer `/report` first). |
| `/hourly run` | `node bin/jev.js hourly`. They typed it, so that is their go for one search. Read the counts back. |
| `/hourly dry` | `node bin/jev.js hourly --dry`. It searches the boards and writes nothing. Say what it would have added. |
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

- **A job the tool can fill** is queued. `/apply` takes these before older
  queued jobs while they are fresh. After twelve hours it leaves the page and
  stays in the queue.
- **A board-only listing** (Indeed, LinkedIn and the like) waits on the page for
  twelve hours, then moves to **Needs you** with "apply on the employer's site".
  The tool never tries to fill it.

Tick one job, or the header box for all of them, then **Mark selected
applied**. Each is recorded as applied, leaves the list, and is never shown
there again. The page refreshes itself every minute while it is open.

## What you never do

- **Never install or remove the timer unless the user typed that command**
  (`/hourly install`, `/hourly pause`) in this conversation.
- **Never start an application, a sign-in, an account, or a mail read** from
  this skill. The hourly run does none of those. A board's emailed code belongs
  to `/apply` and `/resume`, read over the Gmail MCP with consent.
- **Never change `DAILY` limits to make more fit.** The hourly search does not
  send.
- If the permission system declines a command, show it in a `bash` block and let
  them click Run.

## Per-portal rules

Each portal's roles, places, exclusions, results per call, pause and minute
offset are in its own `data/profile.json` under `search`. They are not in
source. When the user wants a different role, city or exclusion, that is
`/profile`, and the next hourly run uses it.
