---
name: discover
description: Refresh the job queue without a browser. Use when the user says /discover, "find jobs", "refresh the queue", or before an /apply run when the queue is stale. Pulls every source, filters, rates with JEV, writes data/queue.json and applications/all.csv.
model: claude-sonnet-5-5
effort: high
---

# /discover: build the queue

No browser needed. Run from the repo root:

```
node bin/jev.js discover
```

It prints counts and the top 50 queued jobs with scores. Takes about a
minute. The first search of a day costs about six cents of JEV. A later
one costs less, because a posting that has not changed keeps its rating.

Then show the user the top 15 as a short table (score, company, title,
location, posted) and one line of totals. Mention jobs that were skipped for
a reason they might want to override, grouped by reason, using
`node bin/jev.js status`.

Options:
- `--no-boards` skips the employers' boards and freehire (faster, fewer
  postings). Without it the boards are Greenhouse, Lever, Ashby and Workable
  read whole and Workday sites searched, for every board in the queue, the
  seed list and what freehire names. Intern and new-grad titles are never kept.
- `--limit N` rates only N new jobs, for a quick check.

To include the user's own tracking sheet, they export it as CSV into
`data/imports/` first; every file there is read on the next discover.

If it fails with a DEEPSEEK_API_KEY error or a missing profile, run
`node bin/jev.js doctor` and follow its next step, or use `/setup`. If a source fails, the run continues without it and says so
on stderr.
