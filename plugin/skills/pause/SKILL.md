---
name: pause
description: Stop recording observations for the current session while keeping past memory available. Use when the user says "don't record this", "pause memory", "stop tracking this session", or is about to do something they don't want in their history.
---

# Pause Observation Recording

Stops claude-mem from recording what happens in this session. Past memory keeps
being injected — only the writing stops.

## How to run it

**Step 1 — get the session id.**

```bash
echo "$CLAUDE_CODE_SESSION_ID"
```

If it prints nothing, stop. Tell the user you cannot identify the current
session, so you will not change anything. Do not guess an id.

**Step 2 — pause.**

```bash
npx @bjlee2024/claude-mem session pause "$CLAUDE_CODE_SESSION_ID"
```

**Step 3 — tell the user what changed.**

Say all four:

- Tool-use observations and the end-of-session summary will not be recorded.
- Context injection continues — past memory still reaches you.
- Observations already recorded in this session stay; this does not erase them.
- It lifts automatically when the session ends. Use `/claude-mem:resume` to turn
  recording back on sooner.

The last point matters: without it the user is left wondering whether their next
session is still paused.
