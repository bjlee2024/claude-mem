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

Say all five:

- Tool-use observations and the end-of-session summary will not be recorded.
- The text of your prompts is still recorded — pausing does not stop that.
- Context injection continues — past memory still reaches you.
- Observations already recorded in this session stay; this does not erase them.
- It does NOT lift when the session ends. Run `/claude-mem:resume` to turn
  recording back on, or it lifts automatically after 24 hours. A new session
  always starts with recording on, so there is nothing to undo tomorrow — the
  pause only carries over if you reopen this same session with `claude --resume`.

The last two points matter: without the prompt-text point, a user pausing for
sensitive work may think nothing about this turn is recorded. Without the
lifetime point, a user who wants recording back on this session may assume
ending the session is enough.

If the `session pause` command exits non-zero, say plainly that the pause did
NOT take effect and stop — do not relay the reassurances above. The same
applies to `/claude-mem:resume`.
