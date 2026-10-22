---
name: report
description: Open the user's dashboard, the main screen of the tool. Use when the user says /report, "show me my applications", "how is the search going", "what needs me", "open the dashboard", or wants to answer a form's question, change a status, or turn the daily run on or off without typing commands.
model: claude-sonnet-5-5
effort: low
---

# /report: the dashboard

Run from the repo root:

```
node bin/jev.js report --open
```

It starts a page on the user's own machine (`http://127.0.0.1:4545`) and
opens it. Nothing leaves the machine. The command keeps running until they
press Ctrl-C. The page has five screens:

- **Today.** One line (sent today, waiting, in the queue), the
  totals, and three small charts.
- **Last 12 hours.** Every job the tool first saw in the last twelve hours,
  newest first, with the posted time, found time, fit and why it is there.
  `/apply` takes these before older queued jobs while they are fresh. A
  board-only listing moves to **Needs you** when its twelve hours are over.
  Tick one job, or the header box for all, then "Mark selected applied"; it
  is recorded as applied and leaves the list for good. A link like
  `/#recent` opens this screen directly.
- **Needs you.** Everything only they can do, each with its button:
  - a question a form asked that their profile could not answer. They
    type or pick the answer and press "Save for next run". Nothing is
    sent then: the job goes back in the queue and the next `/apply` or
    daily run fills it with that answer. "Remember for future applications" keeps the
    answer as a standing answer. A question about the right to work has no
    box: that answer is one per country and lives in the profile
    (`/profile`).
  - a form open and waiting (an emailed code, a robot check, a sign-in):
    "Show the form" brings it to the front, "Find the email" opens their
    mail at a search for it. They do it, then `/resume`.
  - a form clicked and never confirmed: "I got a confirmation", or "It was
    not sent".
  - an email the tool could not place: they pick the application and what
    it says.
- **Applications.** Every job, with tabs, a filter, a status select, a
  notes box, and the reply that came back.
- **Automation.** The daily run: an "Apply automatically" switch with a
  time, the next run, "Pause future runs" (removes the schedule),
  "Stop it after this application" while a run is working, their daily
  rules as a form, and today's result in one line. Turning the switch on installs the schedule;
  that is their click, not yours.

`node bin/jev.js report --static applications/report.html` writes a snapshot page
with Today and Applications only, for keeping or sending. Nothing can be
changed from a snapshot.

## Keeping it running

A portal's dashboard can run as a systemd user service, so it survives a
reboot:

```bash
node bin/jev.js report --port <port> --install-service
node bin/jev.js report --service-status
node bin/jev.js report --remove-service
```

The service is named after the folder, so each portal has its own. It
restarts if it exits badly and writes to `data/runs/report.log`. Run the
install from the portal's own folder with that portal's port. On macOS,
use a LaunchAgent instead.

The five dashboards and their ports are listed in the README under
**Where the five dashboards live**.
