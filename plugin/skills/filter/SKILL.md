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

Prefer what's already on screen: the context block injected at session start
opens with a line like `[owner/repo] recent context, ...` — reuse that
`owner/repo` string if you can see it. It needs no derivation and is always
right.

If it's not visible, derive it the same way claude-mem does
(`src/utils/project-name.ts::parseOwnerRepo` — read it if anything below is
ambiguous):

```bash
git config --get remote.origin.url
```

Normalize that URL to `owner/repo`:

1. Strip a trailing `.git`.
2. Strip a leading `ssh://`, `https://`, `http://`, or `git://` scheme.
3. If what's left has a `:` before the first `/` — the scp-style shorthand
   (`user@host:owner/repo`, including host aliases like
   `github.com-medit`) — take everything after that `:` as the path.
   Otherwise take everything after the first `/` as the path.
4. Split the path on `/` and take the last two segments as `owner/repo`.

Do not just take "the last two path segments" of the raw URL — for an
scp-style remote like `git@github.com-medit:bjlee2024/claude-mem.git`, that
naive reading yields the whole
`git@github.com-medit:bjlee2024/claude-mem` string, not `bjlee2024/claude-mem`.

If the `git config` command fails or there's no `origin` remote, use the
basename of the git repo root (`git rev-parse --show-toplevel`), not the
basename of the current directory — they differ in subdirectories and
worktrees. If it's not a git repo at all, fall back to the current
directory's basename.

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

Call the `search` tool with no query term, so results come back newest-first.
Always include `type: "observations"` — without it, the worker also
searches session summaries and user prompts, and once the requested author's
observations run out the list quietly fills with other people's prompts
under this author's heading.

- with an author: `search({ gitUser: "<resolved name>", project: "<resolved project>", type: "observations", limit: 20 })`
- for `off`, or for `me` when git user resolution failed: `search({ project: "<resolved project>", type: "observations", limit: 20 })`

Do not pass a `query`. Passing one turns this into a full-text search and
changes the ordering.

If the call fails specifically on resolving `project` (for example, a 403
from a project-scoped setup that can't resolve/create projects), retry once
without `project` — keep `gitUser` and `type: "observations"` if you have
them.

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
- `search` requires either a `query` or a `project` filter (or a date range)
  on this worker; a query-less call with neither is rejected with a 400.
  This is why every example above always includes `project`.
