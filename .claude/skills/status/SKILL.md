---
name: status
description: Say where the job search stands in a few lines. Use when the user says /status, "where am I", "what happened", "how many did I send", "what is waiting for me", or "what does this cost".
model: claude-sonnet-5-5
effort: low
---

# /status

Run these and give one short answer, not four dumps:

```
node bin/jev.js status
node bin/jev.js doctor
node bin/jev.js cost
node bin/jev.js schedule status
```

Say, in this order and only what applies:

1. **Sent**: today and in total.
2. **Waiting for you**: each form, what it asks for, and that `/resume`
   picks it up after they have done it in the tool's Chrome window.
3. **Left for you**: how many are on the by-hand list, and the two or
   three most common reasons. `node bin/jev.js log --manual` lists them.
4. **Queue**: how many jobs are ready to apply to, and how old the search
   is. Offer `/discover` when it is more than a day old.
5. **Accounts and the daily run**: one line each, only if set up.
6. **Cost**: what DeepSeek has cost, the typed questions and the writer apart.
7. **Next step**: the one thing `doctor` names, as a slash command where
   there is one (`/setup`, `/discover`, `/apply`, `/accounts`, `/daily`,
   `/resume`, `/report`).

Never print a path, an id or a number they did not ask for when a sentence
will do. `/report` is the full picture, in a page.
