---
name: resume
description: Resume recording observations for the current session after it was paused. Use when the user says "start recording again", "resume memory", or "unpause".
---

# Resume Observation Recording

Turns recording back on for this session after `/claude-mem:pause`.

## How to run it

**Step 1 — get the session id.**

```bash
echo "$CLAUDE_CODE_SESSION_ID"
```

If it prints nothing, stop and tell the user you cannot identify the current
session. Do not guess an id.

**Step 2 — resume.**

```bash
npx @bjlee2024/claude-mem session resume "$CLAUDE_CODE_SESSION_ID"
```

**Step 3 — tell the user what changed.**

Recording is back on from this point. Anything that happened while paused was
not recorded and cannot be recovered — say so plainly rather than implying it
will be backfilled.

If the user was not paused to begin with, the command is harmless; say that
recording was already on rather than implying something changed.
