---
name: resume
description: Pick up the forms that wait for the user and settle the ones that were clicked but not confirmed. Use when the user says /resume, "I typed the code", "I passed the check", "I signed in", "continue", or after a run that said forms are waiting.
argument-hint: "[job id ...]"
model: claude-sonnet-5-5
effort: low
---

# /resume

A form waits for the user when only they can do the next thing: pass a
robot check, finish a sign-in, or type a code the board emailed. It stays
open in the tool's own Chrome window. This skill does the rest.

1. Run `node bin/jev.js status`. If nothing waits and nothing is unconfirmed, say
   so and stop.

2. For a form that waits at an **emailed code**, find the board's newest code
   with the Gmail MCP and give it to the tool on standard input:

   ```bash
   node bin/jev.js code <id> --submit <<'EOF'
   <the code>
   EOF
   ```

   The tool writes it into the form's code box, reads it back, clicks
   Submit, and records the application only when the page confirms. Never
   put the code on the command line, and never repeat it in your reply.
   If no code arrives in the mailbox, leave the form open for the user.

3. For forms that wait at a robot check, or that the user still wants to
   finish by hand, run:

   ```
   node bin/jev.js resume
   ```

   It watches each form while they finish it and records the application
   when the confirmation shows. Tell them which form it is on.

4. For forms whose Submit was clicked with no confirmation seen, run
   `node bin/jev.js reconcile`. If it cannot tell, look for the
   employer's confirmation email. If it is there, show it and mark the job
   with `node bin/jev.js mark <id> --status applied`; if not,
   `--status queued` to try again.

5. A form that waits at a **sign-in** (the reason mentions a sign-in, a
   password, account terms or a verification link) is different: carrying
   on means the tool signs in at that employer. You do not start that.
   Show the command, which has a Run button:

   ```bash
   node bin/jev.js resume --submit
   ```

6. Say what was sent, what still waits and why.

## What you never do

- Never pass a robot check and never sign in. The user does those in the
  tool's window; you only watch and record.
- Never put a code in a command argument, a reply, a plan or a record: it
  travels on standard input to `code <id>` and nowhere else.
- Never use `mark --status applied` unless the confirmation was seen, in
  the page or in the employer's own email.
