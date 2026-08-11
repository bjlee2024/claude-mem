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

**Step 1 — resolve the project name.**

Every call below needs `project`, or the search has no filter to run on and
errors out (see Notes). The cheapest source is what's already on screen: the
context block injected at session start opens with a line like
`[owner/repo] recent context, ...` — reuse that `owner/repo` string if you can
see it.

If it's not visible, derive it the same way claude-mem does:

```bash
git config --get remote.origin.url
```

Normalize the URL to `owner/repo` (the last two path segments, minus a
trailing `.git`). If the command fails or there's no `origin` remote, fall
back to the basename of the current directory.

**Step 2 — resolve the author.**

For `me` (or no argument), get the current git user:

```bash
git config user.name
```

If that prints nothing or fails, tell the user you could not read their git
author and fall back to the `off` behavior below — still passing `project`.
Do not return an empty screen, and do not call `search` with neither `query`
nor a filter.

For a literal name, use it as given. For `off`, skip the author filter
entirely; `project` alone is enough to satisfy the filter requirement.

**Step 3 — query.**

Call the `search` tool with no query term, so results come back newest-first:

- with an author: `search({ gitUser: "<resolved name>", project: "<resolved project>", limit: 20 })`
- for `off`, or for `me` when git user resolution failed: `search({ project: "<resolved project>", limit: 20 })`

Do not pass a `query`. Passing one turns this into a full-text search and
changes the ordering.

**Step 4 — present the results.**

List them the way `mem-search` does. Titles already carry `by <user>,` so the
author is visible without extra formatting.

## When results are empty

Observations recorded before author capture shipped have no author, so any
author filter excludes them. This is expected — say so rather than implying
the history is gone:

> No observations found with author `<name>`. Author tracking is a recent
> addition, so observations recorded before it shipped have no author
> attached — that history isn't lost, it just doesn't match this filter.

Offer `/claude-mem:filter off` as the way to see everything.

## Notes

- This command only reads. It does not change any setting, and it does not
  affect what gets injected at the start of the next session.
- `search` requires either a `query` or at least one filter (`project`,
  `gitUser`, `type`, a date range, `concepts`, `files`, or `platformSource`);
  a call with none of those is rejected with a 400. This is why every example
  above always includes `project`.
