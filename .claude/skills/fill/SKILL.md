---
name: fill
description: Fill the application form the person has open in the tool's Chrome, from their profile, and leave it for them to send. Use when the person says "fill this job", "fill the form", "fill this application", or opens a posting and asks for it to be filled.
---

# /fill: the form the person is looking at

`page` works on the tab, not the queue. The person opens a posting, you read the
form, decide the values from `data/profile.json`, write them, and read every one
back. You never submit; the person does.

Run every command from the repo root with `node bin/jev.js page <action>`. The
full reference is `docs/PAGE.md`.

## The loop

1. `page tabs`. Say which tab you are working on if there is more than one.
   If the person gave a link and it is not open, `page open <url>`.
2. `page dump --options`. Every control, its label, its kind, its selector, its
   current value and the options a choice offers. If the posting itself is open
   rather than its form, `page click "Apply"` first, or `page frame` for an
   embedded form.
3. Decide every value from the profile. Anything the profile does not answer is
   left out and reported, never invented.
4. Write a plan file in /tmp and run `page fill --plan <file>`. The resume comes
   from the board the job was opened on: `page fill` reads it from the tab, and
   `--board <key>` names it when the tab cannot. Check the board line it prints.
5. Read the report: what landed, what failed, and every required control still
   empty. `page dump` again if the page moved.
6. If the form has more pages, `page next` and go back to step 2 for each page.
7. Tell the person what is filled, what is still empty, and that nothing was
   sent. They read it and press Submit.

## Where an answer comes from

| Question | Source |
|---|---|
| Name, email | `profile.name`, `profile.email` |
| Phone, address | the board's: `data/boards/<board>.json`, else `profile.phone` and `profile.address` |
| LinkedIn, GitHub, website | `profile.links` |
| Resume | the board's file, `documents/resume/<board>.pdf`; `profile.resume.path` when no board is known |
| Work authorization, sponsorship, citizenship | `profile.workAuthorization` and the standing answers |
| Education, dates, GPA | `profile.education` |
| Employers, titles, dates, experience | `profile.experience` |
| "Years of experience" | 8+ |
| Voluntary self-identification | `profile.demographics`, declined |
| Salary | never volunteered; "Negotiable" only when a box will not submit empty |
| "Why this company", "Tell us about yourself" | written from `profile.facts` and `profile.summary`, in the posting's language |
| Recurring questions | `profile.answers` |

A value that is not in the profile is never guessed. Report it and ask.

## What you never do

- Never click Submit, and never press a control whose words mean Submit. If the
  person asks for it, tell them the form is filled and it is theirs to send.
- Never sign in, and never type a password. If the tab is on a sign-in page,
  say so and let the person sign in in that window.
- Never change work authorization, education or dates to fit a form.
- Never tick a marketing, newsletter or job-alert box.

## When a field will not take a value

The report says why. A choice the list does not have can be tried with
`alternates` (other wordings of the same answer). A control the page draws in a
way the tool cannot drive is left for the person: say which one and what it
asks, rather than filling it with something approximate.
