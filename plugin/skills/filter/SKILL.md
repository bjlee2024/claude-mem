---
name: filter
description: Show observations from one git author only. Use when the user asks to see their own past work, or one teammate's work, on the current project — "what did I do here", "show alice's work", "filter by author".
---

# Author Filter

Show observations from a single git author on the current project.

## Usage

- `/claude-mem:filter me` — observations you recorded
- `/claude-mem:filter alice` — observations `alice` recorded
- `/claude-mem:filter off` — most recent observations, no author filter
- `/claude-mem:filter` — same as `me`

## How to run it

**Step 1 — resolve the author.**

For `me` (or no argument), get the current git user:

```bash
git config user.name
```

If that prints nothing or fails, tell the user you could not read their git
author and show unfiltered results instead. Do not return an empty screen.

For a literal name, use it as given. For `off`, skip the filter entirely.

**Step 2 — query.**

Call the `search` tool with no query term, so results come back newest-first:

- with an author: `search({ gitUser: "<resolved name>", limit: 20 })`
- for `off`: `search({ limit: 20 })`

Do not pass a `query`. Passing one turns this into a full-text search and
changes the ordering.

**Step 3 — present the results.**

List them the way `mem-search` does. Titles already carry `by <user>,` so the
author is visible without extra formatting.

## When results are empty

Observations recorded before author capture shipped have no author, so they are
excluded by any author filter. This is expected — say so rather than implying
the history is gone:

> `<name>` 작성자로 기록된 관측이 없습니다. 작성자 기록은 최근에 추가된
> 기능이라 그 이전 관측에는 작성자 정보가 없습니다.

Offer `/claude-mem:filter off` as the way to see everything.

## Notes

- This command only reads. It does not change any setting, and it does not
  affect what gets injected at the start of the next session.
- On the client/server-beta runtime this needs a server built after the
  author-filter change; older servers reject a search with no query term
  with a 400.
