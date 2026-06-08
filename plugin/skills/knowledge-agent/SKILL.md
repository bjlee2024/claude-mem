---
name: knowledge-agent
description: Build and query AI-powered knowledge bases from claude-mem observations. Use when users want to create focused "brains" from their observation history, ask questions about past work patterns, or compile expertise on specific topics.
---

# Knowledge Agent

Build and query focused "brains" from claude-mem observations — "everything about hooks", "all decisions from the last month", "all bugfixes for the worker service".

There are two mechanisms depending on the **runtime**. Detect it first:

```bash
CMEM_RUNTIME="$(node -e "try{const s=require(require('path').join(require('os').homedir(),'.claude-mem','settings.json'));process.stdout.write(String(s.CLAUDE_MEM_RUNTIME||'worker'));}catch{process.stdout.write('worker');}" 2>/dev/null || echo worker)"
echo "claude-mem runtime: $CMEM_RUNTIME"
```

- **`worker`** → persistent **corpus** tools (Chroma-backed AI session). See [Worker mode](#worker-mode).
- **`client` / `server-beta`** → a **lightweight in-conversation brain** built from the `search` tool (corpus tools are not available server-side). See [Server / client mode](#server--client-mode).

---

## Server / client mode

The corpus tools (`build_corpus`/`prime_corpus`/…) are Chroma/worker-only and return a guidance message in server mode. Instead, build the brain right here in the conversation using the **`search`** MCP tool — in server mode `search` returns the **full observation content** in one call, so the retrieved set *is* the corpus.

### Step 1: Build (gather) the brain

Run `search` with the topic and filters. Pull enough to cover the subject (raise `limit`, paginate with `offset` for big topics):

```text
search(query="hooks lifecycle", project="claude-mem", obs_type="decision,discovery", limit=100)
```

Useful params: `query`, `project`, `type` (observations|sessions|prompts), `obs_type` (bugfix,feature,decision,discovery,change,refactor), `dateStart`/`dateEnd` (YYYY-MM-DD), `limit` (max 100), `offset`, `orderBy`. Run several searches with different angles (concepts, file names, error strings) to assemble a thorough set.

### Step 2: Prime

No separate session is needed — **you are the knowledge agent**. Hold the gathered observations as your working context. If a topic is large, summarize the retrieved observations into a compact internal "knowledge sheet" (key decisions, bugs, file map, gotchas) before answering, so follow-ups stay grounded.

### Step 3: Query

Answer the user's question from the gathered observations, citing observation IDs/dates ("per #11131 on Jun 6 …"). For follow-ups or gaps, run more `search` calls (different query/filters) and fold the results in. To "rebuild/refresh", just re-run the searches — server data is always current.

> Persistence: this brain lives in the current conversation, not on disk. For a new session, re-gather with `search`. For a synthesized, reusable answer, save your knowledge sheet to a markdown file.

---

## Worker mode

Persistent corpora backed by Chroma and a dedicated AI session.

### Step 1: Build a corpus

```text
build_corpus name="hooks-expertise" description="Everything about the hooks lifecycle" project="claude-mem" concepts="hooks" limit=500
```

Filter options:
- `project` — filter by project name
- `types` — comma-separated: decision, bugfix, feature, refactor, discovery, change
- `concepts` — comma-separated concept tags
- `files` — comma-separated file paths (prefix match)
- `query` — semantic search query
- `dateStart` / `dateEnd` — ISO date range
- `limit` — max observations (default 500)

### Step 2: Prime the corpus

```text
prime_corpus name="hooks-expertise"
```

This creates an AI session loaded with all the corpus knowledge. Takes a moment for large corpora.

### Step 3: Query

```text
query_corpus name="hooks-expertise" question="What are the 5 lifecycle hooks and when does each fire?"
```

The knowledge agent answers from its corpus. Follow-up questions maintain context.

### Step 4: List corpora

```text
list_corpora
```

Shows all corpora with stats and priming status.

### Tips

- **Focused corpora work best** — "hooks architecture" beats "everything ever"
- **Prime once, query many times** — the session persists across queries
- **Reprime for fresh context** — if the conversation drifts, reprime to reset
- **Rebuild to update** — when new observations are added, rebuild then reprime

### Maintenance

```text
rebuild_corpus name="hooks-expertise"
reprime_corpus name="hooks-expertise"
```

`rebuild_corpus` re-runs the stored filter to pick up new observations; `reprime_corpus` clears prior Q&A context and reloads the corpus into a fresh session.
