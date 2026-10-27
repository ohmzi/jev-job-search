---
name: events
description: Read back what the runs did from the event log, per portal or all four together, to find what to improve. Use when the user says /events, "what happened in the runs", "analyse the log", "which boards give jobs", "why was nothing applied", "why are jobs set aside", or asks how the search or the apply pass behaved over the last days.
model: claude-sonnet-5-5
effort: medium
---

# /events

Every step of every run is written to the event log, one JSON line per step,
in `data/runs/events/<day>.jsonl` of each checkout: commands, Indeed and
LinkedIn queries, freehire calls, every employer board read, every job added
and every status it moved through, the apply pass's picks and why the rest
were not picked, waits for the browser, each form's outcome by field label,
and each submit. Nothing secret is kept, and links keep only their origin
and path.

| Command | What it runs |
|---|---|
| `/events` | `node bin/jev.js events`: this portal, last 7 days. On the main board it reads all four. |
| `/events all` | `node bin/jev.js events --all`: the four portals through their dashboards, plus this checkout. |
| `/events 30` | `node bin/jev.js events --days 30` (add `--all` for every portal). |
| `/events board` | `node bin/jev.js events --json --kind board`: the raw events of one family (board, job, apply, form, hourly, freehire, jobspy, lock). |

Read the report and answer what the user asked in a few lines. When they ask
what to improve, look at these, in this order, and say what the numbers
point to:

- **Boards that failed every read**: a slug that is wrong or gone. Suggest
  dropping or fixing it in `src/sources/companies.ts`.
- **Boards that never had a posting that fit**: candidates to drop, or a sign
  the portal's title rules are too narrow.
- **Not picked from Last 12 hours**: the reasons the apply pass passed jobs
  over. Many "a daily limit" means the caps bind; many "no room this pass"
  means `HOURLY.applyCount` is the limit.
- **Why jobs were set aside** and **fields the tool could not set most
  often**: the questions worth a standing answer (`/profile`) or a fix in the
  form code.
- **After the click**: how many clicks were not confirmed.

Do not change a limit in `src/config.ts` to send more without the user
asking; the limits in CLAUDE.md stand. To look at one job's whole path, run
`node bin/jev.js events --json --kind job` and filter by its id.
