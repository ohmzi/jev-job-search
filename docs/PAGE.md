# Filling the form in front of you

`page` is the manual way to use the tool. You open a job in the tool's own Chrome
and the form is filled from your profile while you watch, one field at a time.
Nothing is sent: you read the page, fix what is wrong, and press Submit yourself.

This is the half of the tool for a posting you found yourself. `discover` and
`apply` (the `/discover` and `/apply` skills) still do the whole search on their
own. In Claude Code, `/fill` walks this loop with you; from a terminal it is the
commands below.

## The commands

Run them from the repo root.

```bash
node bin/jev.js page tabs                     # what is open, and which tab is on screen
node bin/jev.js page open <url>               # open a posting in the tool's Chrome
node bin/jev.js page dump                     # every control, its label, its value and its options
node bin/jev.js page dump --options           # also open each custom dropdown and read its list
node bin/jev.js page text --text 4000         # the page's visible words, for a written answer
node bin/jev.js page fill --plan plan.json    # write the values, read every one back
node bin/jev.js page next                     # press the form's own Next or Continue
node bin/jev.js page click "Apply"            # press a control by its words
node bin/jev.js page frame                    # go into an embedded form (a Greenhouse iframe)
node bin/jev.js page close --url <part>       # close one tab
```

Every command takes `--tab <id>` or `--url <part>` when more than one tab is
open. With neither, it works on the visible tab that has a form on it.

### The plan file

`fill` takes a JSON file (or `-` for standard input):

```json
{
  "board": "android-nj",
  "fills": [
    { "selector": "#first_name", "kind": "text", "value": "Omar" },
    { "selector": "#country", "kind": "combobox", "value": "United States" },
    { "selector": "#question_1234", "kind": "combobox", "value": "Yes", "alternates": ["Yes, I am"] }
  ],
  "uploads": [
    { "selector": "#resume", "path": "/absolute/path/to/resume.pdf" }
  ],
  "clear": ["#notes"]
}
```

`selector` and `kind` come from `page dump`. `alternates` are other wordings of
the same answer, tried in order when a list does not have the first. `board` is
optional: the tab usually says which board the job came from. `"resume": false`
leaves the resume box alone.

`fill` prints what landed, what did not, and every required control the page
still shows empty, with the options that control offers. That list is what a
person has to answer before the form can go.

## The submit guard

While `fill` writes, an in-page guard cancels the page's own submit event. An
Enter that lands on the form, or a widget that presses a button itself, cannot
send the application. The guard is removed before the command returns, so the
Submit button works normally when you press it.

`fill` says where the page was before it started and where it ended. If those
differ, read the page before sending anything.

## Which board, and what it changes

A job opened from one board is filled with that board's resume, city and phone,
because the four boards look in different places: Android or Full Stack, New
Jersey or Texas. Everything else (facts, answers, work authorization, education)
is the one profile's, so correcting an answer once corrects it everywhere.

| Board | `--board` | Answers for | Resume sent |
|---|---|---|---|
| Android, New Jersey | `android-nj` | Jersey City, NJ 07302, 551-320-2252 | `documents/resume/android-nj.pdf` |
| Android, Texas | `android-tx` | 770 Cantegral St, Dallas, TX 75204, 214-896-9509 | `documents/resume/android-tx.pdf` |
| Full Stack, New Jersey | `fullstack-nj` | Jersey City, NJ 07302, 551-320-2252 | `documents/resume/fullstack-nj.pdf` |
| Full Stack, Texas | `fullstack-tx` | 770 Cantegral St, Dallas, TX 75204, 214-896-9509 | `documents/resume/fullstack-tx.pdf` |
| none known | | `data/profile.json` | the resume in `data/profile.json` |

Those three things live in `data/boards/<board>.json`, which is an override on
`data/profile.json`, not a second profile.

The board is read from the tab, in this order:

1. `--board <key>` on the command, when you say which one.
2. The page's referrer. A posting opened by clicking a row on a dashboard keeps
   that dashboard as its referrer, so a tab opened from
   `jobnja.ohmzhomelab.ca` (or `127.0.0.1:7421`) is Android, New Jersey.
3. The board the tab was first seen on. The tab remembers it, so a form one hop
   from the posting (Apply opens another page, or the page was reloaded) keeps
   the board it started on.
4. The boards' own records: a job only one board holds is that board's. The
   applied records are shared across the four, so this only settles a job that
   has not been applied to.

`page board` says what it decided for the tab on screen, and `page tabs` names
the board each tab came from. `page fill` prints the board and the resume file
it sent, so one look tells you whether it is right.

The four resumes are copied from the machine that runs the boards. When one
changes there, run `./scripts/sync-boards.sh` to pull them again. The files are
git-ignored (they sit under `documents/` and `data/boards/`).

## What it will not do

- It never clicks Submit, and it never signs in.
- It fills only the values it is given. Nothing is invented. A required field
  the profile cannot answer is reported, not guessed.
- Voluntary self-identification is declined, from the profile.
- Salary is never volunteered. A box that will not submit empty gets
  "Negotiable".

## Where the answers come from

`data/profile.json` is the only source. It holds your contact details,
education, experience, skills, work authorization, standing answers and the
default resume. Change it there, not in a form: the next job then gets the
corrected answer. The board changes only which resume file is attached; every
answer still comes from this one profile.

The profile is git-ignored, like the resume, the applications and the browser
profile. Nothing personal is committed.

## The browser

The tool drives its own Chrome window with its own profile at
`~/.local/state/jev/chrome-profile`. Your everyday browser is not touched. A
site that wants a sign-in (Workday, LinkedIn) is signed into once in that
window, and the session is kept for next time.
