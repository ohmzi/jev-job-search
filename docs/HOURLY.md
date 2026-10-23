# The hourly search and the Last 12 hours page

A job that went up this morning is worth more than one that has sat in the
queue for a week. The hourly search asks the job boards for recently posted
jobs, puts them in that portal's queue, and shows them on a **Last 12 hours**
page in the dashboard. The portal's profile sets how far back each call looks:
six hours to start, so a board that indexes a posting late is not missed. A
strict one-hour window is mostly empty, because a single hour of Android or
full-stack postings in one metro is a handful of jobs at most. The jobs on that page are taken first by
`/apply` while they are fresh.

It is read-only. It never opens Chrome, fills a form, signs in, makes an
account, reads mail or sends anything.

## One run

`node bin/jev.js hourly`, or `/hourly run` in Claude Code, does four things:

1. **Ages held jobs out.** A board-only listing whose twelve hours are over
   becomes `needs_review`, so it appears in **Needs you** with the reason
   "posted more than 12 hours ago; apply on the employer's site yourself".
   Only a job the hourly run itself held is touched. A status a person chose is
   final.
2. **Searches.** It runs the portal's JobSpy queries through the `jobspy`
   Docker image, asking for jobs posted inside the profile's window. The four
   portals start at six hours.
3. **Follows board listings to the employer.** A new Indeed or LinkedIn listing is
   not a form. The board's MCP server (LinkedIn: `uvx mcp-server-linkedin`; Indeed:
   the `openings-mcp` Docker image) is asked for the posting's apply link. If the
   reply holds an https link to an application board, or to a page that looks like
   an application, the job is queued at that link and the apply pass can fill it. The
   servers read postings and apply for no one. `data/cache/listing-links.json` keeps
   each answer: a link for good, "no link" for six hours, a failure not at all. At most
   `MCP.maxPerRun` listings are asked about per run, and a server that will not start is
   skipped for the run.
4. **Writes the finds.** Each job is mapped, filtered by the portal's roles and
   area, deduplicated across Indeed and LinkedIn, and written to
   `data/queue.json` and `applications/all.csv`.

A run that the machine missed widens the next search. The last successful run
is kept in `data/runs/hourly.json`, and the next run asks for enough hours to
cover the gap, up to a day.

## The twelve-hour rule

A job is on the page while both hold:

- the tool first saw it less than twelve hours ago;
- its posted date, when the board gave one, is not older than the same window.

Job boards give a posted date, not a time. The hourly search asks for jobs
posted inside a short window, so first-seen time is the hour-accurate timestamp
every board can support. The posted date is still checked, because a board can
resurface an old listing. A job is only added once: the queue keeps the time it
was first seen, so widening the search window does not make an old find fresh
again.

When a board gives no posted date, the job is shown with "posted time unknown"
and ages out twelve hours after first seen.

## What happens to a job

| Kind of job | In the queue | On the page | At twelve hours |
|---|---|---|---|
| A form the tool can fill | `queued` | Yes | Leaves the page, stays queued for `/apply` |
| A listing whose MCP gave an employer form | `queued`, at the employer's link | Yes | Leaves the page, stays queued for `/apply` |
| A board-only listing (Indeed, LinkedIn) with no link | `queued`, held | Yes | Becomes `needs_review` in **Needs you** |
| Refused by a code filter | `skipped` with the reason | Yes, with the reason | Leaves the page |
| Already applied to | Its existing status | No | Never comes back |

A board-only listing is one whose MCP gave no employer link. The apply step asks again
when the job's turn comes (`followListings`, at the start of every apply run, so `/apply`
and `daily` do too), and if there is still none it opens the page in Chrome and
follows its Apply button (`openForm`), which is the Chromium fallback. If it wants a sign-in, the tool brings the window to the front, notifies
the person and waits; they sign in, and the form is filled. If the page has no
form or the wait runs out, the tab is left open for them. The job is not
skipped. `/apply` tries the same page the same way.

## Applying fresh jobs

The hourly run can send a fresh job right after finding it, when the posting resolves to a form
the tool can fill. Turn it on with `search.apply: true` in the portal's profile (it is on in these
four portals) and a `data/policy.json`. Without a policy the search still runs, but nothing is
sent.

- Fillable links go first: Greenhouse, Lever, Ashby, Jobvite, Rippling, BambooHR, Workable,
  JazzHR, and Workday where the person has an account. A board-only page is tried too. If it wants
  a sign-in, the tool brings the window to the front, notifies the person and waits up to ten
  minutes (`HOURLY.signInWaitMs`). If they sign in, it fills and continues; if not, the tab stays
  open and the job waits in Needs you. It never types a password, makes an account or passes a
  robot check.
- A page the tool could not fill, or one with no form at all, is left open in front instead of
  being closed, so the person can look at it.
- Up to two applications per portal per hour, one role per employer, inside the daily limits: the
  day's target, the per-board and per-employer counts, the employer's open forms, the pauses after
  a human check, and the gaps between submissions.
- Fresh jobs bypass the score check (`admitRecent`). Their gate was the portal's role and area
  filters, not a fit score.
- One job gets two attempts. After the second it becomes `needs_review`, says "left for you after
  two attempts", and is never picked again. A code, sign-in, robot check, signature or unconfirmed
  click is left for the person on the first attempt and is never retried.
- The four portals share one Chrome, so a global lock lets only one of them apply at a time. The
  timers are staggered, and a portal that finds the lock held skips its apply pass that hour.
- A shared registry records every confirmed application by company and title. A job sent from one
  portal is marked applied in the others and is not sent again. A manual `/apply` checks it too.

Many listings on Indeed and LinkedIn lead to an employer form the MCP can name. The rest are
opened and tried, not skipped. A sign-in window is left for you, and a page with no form stays open for
you to take from there.

## The page

`/report` has a **Last 12 hours** screen with every job first seen inside the
window, newest first:

| Column | What it shows |
|---|---|
| Company | The employer |
| Role | The posting, linked |
| Location | The posting's locations |
| Board | The ATS, or the jobspy site |
| Posted | The posted date or exact time, or "unknown" |
| Found | How long ago the tool first saw it |
| Fit | The score when the job was rated, blank otherwise |
| Status | The current status |
| Why here | The skip reason, the hold note, or "new find" |

The page refreshes itself every minute while it is open. Tick one job, or the
header box for all of them, then **Mark selected applied**. Each one is recorded
as applied, leaves the list, and is never shown here again, even if a later
hourly run finds the same posting under a different link.

## Apply priority

`/apply` and the daily run put recent queued jobs first, then fall back to the
usual score order. All the existing safety rules still apply: the daily policy,
the per-board and per-employer limits, the gaps, the read-back, and the submit
guard. Priority changes the order, never the rules.

## Per-portal rules

Each portal has its own `search` block in `data/profile.json`. It is candidate
and region data, so it is not in source. `data/profile.example.json` shows the
shape:

```json
"search": {
  "portal": "example-portal",
  "titleInclude": ["(software|backend|full[\\s-]?stack)", "(developer|engineer|programmer)"],
  "titleExclude": ["designer|manager|sales|recruit|marketing"],
  "terms": ["software developer", "backend engineer"],
  "sites": ["indeed", "linkedin"],
  "countryIndeed": "USA",
  "resultsWanted": 50,
  "hoursOld": 6,
  "maxQueries": 6,
  "gapMs": 4000,
  "minuteOffset": 0,
  "locations": [
    { "query": "New Jersey, USA", "distance": 40, "accept": ["\\bNJ\\b|New Jersey|Jersey City"] }
  ],
  "excludeRemoteOnly": true,
  "excludeCompanies": []
}
```

- `titleInclude` is a list of regexes that must **all** match the title.
- `titleExclude` is a list where **any** match drops the job.
- `terms` and `locations` are multiplied into the calls, up to `maxQueries`.
  `HOURLY.maxQueries` is a hard ceiling of 12 per run.
- `locations[].accept` is tested against the location the board returns.
- `excludeRemoteOnly` drops a posting whose only place is Remote or the whole
  United States, so one job cannot reach two portals.
- `minuteOffset` is the minute past each hour this portal's timer runs. Give
  the four portals different values.

Change it with `/profile`. The next hourly run uses the new values.

## Scheduling

Nothing runs by itself until the person types the command.

```bash
node bin/jev.js schedule install --hourly
node bin/jev.js schedule status --hourly
node bin/jev.js schedule remove --hourly
```

The portal name and minute come from `search.portal` and
`search.minuteOffset`. `--portal <id>` overrides the name.

- **Linux:** a systemd user service and timer in
  `~/.config/systemd/user/jev-hourly-<portal>.{service,timer}`, enabled with
  `systemctl --user`.
- **macOS:** a LaunchAgent at
  `~/Library/LaunchAgents/com.jev-job-search.jev-hourly-<portal>.plist`, with
  `StartCalendarInterval` at the portal's minute.

The machine has to be on and signed in at that minute. Output goes to
`data/runs/hourly.log`.

The daily timer is separate and still uses the name
`com.jev-job-search.daily`. Install the daily schedule in only one portal, or
a later install replaces the earlier one.

## Where the dashboards live

The five dashboards, their repositories and their ports are in the README under
[Where the five dashboards live](../README.md#where-the-five-dashboards-live).
The Last 12 hours screen is at `/#recent` on each. A dashboard reads its own
repository's queue and CSV, so restart it after a code change; the page itself
refreshes every minute.

Each can run as a systemd user service (Linux):

```bash
node bin/jev.js report --port <port> --install-service
node bin/jev.js report --service-status
node bin/jev.js report --remove-service
```

The service is named after the folder, restarts if it exits badly, and writes
to `data/runs/report.log`. On macOS, use a LaunchAgent instead.

## Rehearsal and cost

```bash
node bin/jev.js hourly --dry
```

`--dry` runs the board searches and writes nothing, including the age-out. It
does not call DeepSeek. The hourly run does not rate jobs, so it has no DeepSeek
cost at all.

JobSpy runs from Docker. If Docker is missing, the run says which calls failed
and leaves the queue as it is. The next run tries again.

## What it never does

- No form is sent without every value read back and a confirmation page.
- No password is typed, no account is made, and no verification email is read. A sign-in page is opened and left for the person.
- No CAPTCHA or robot check is passed.
- No mail is read.
- No web page is executed: JobSpy's JSON is parsed and treated as data.
- No key is passed to the Docker call.
