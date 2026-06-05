# Client / Server Split Install — Design Spec

**Date:** 2026-06-05
**Status:** Approved (brainstorming)
**Branch:** `feat/client-server-split`

## Goal

Let claude-mem be installed in two distinct modes so a personal multi-device setup
can share one memory backend:

1. **client** — a thin install that receives a remote server address and stores
   memory to that server. No local memory DB, no local generation.
2. **server** — runs the backend so remote *and* local clients can store memory
   (already deployed here as the Docker + systemd `claude-mem.service` stack).

## Context / Decisions (from brainstorming)

- **Deployment scenario:** personal multi-device, single owner, trusted Tailscale
  network (server host = `omarchy-bj2`, `100.77.250.118:37700`).
- **Client read path:** fully remote (read + write). Client has **no local memory
  DB**; the server is the single source of truth. Session start injects context
  from the remote server.
- **Offline behavior:** local **spool + later sync**. Pending writes queue to a
  local file while the server is unreachable, then flush automatically on
  recovery. Hooks must NEVER block or break the Claude Code session.
- **Install interface:** two commands — `--mode server` and `--mode client`.
- **Project scoping:** per-repo automatic. Client resolves a server project by
  repo name (auto-create), preserving worker-mode semantics. Same repo across
  devices shares memory; different repos stay isolated.
- **Build approach:** **A — daemonless direct + spool.** Hooks call the remote
  `/v1/*` directly via the existing `ServerBetaClient`; failures spool; the next
  hook invocation pumps the spool. No new long-running local process.

## What Already Exists (do not rebuild)

- Runtime selector `src/services/hooks/runtime-selector.ts` (`selectRuntime`,
  `resolveRuntimeContext`) chooses local vs remote per hook.
- `src/services/hooks/server-beta-client.ts` — `ServerBetaClient` with
  `startSession` (`POST /v1/sessions/start`), `recordEvent` (`POST /v1/events`),
  `endSession`, `addObservation`, `searchObservations`,
  `getContextObservations` (`POST /v1/context`). Bearer auth from
  `CLAUDE_MEM_SERVER_BETA_API_KEY`; `ServerBetaClientError.isFallbackEligible()`.
- `observation.ts` and `session-init.ts` already have a server-beta branch.
- `npx claude-mem install --runtime worker|server-beta`.
- Server v1 routes + api-key auth; `ensureProjectAllowed`
  (`src/server/routes/v1/ServerV1Routes.ts:279`): a key with `project_id = NULL`
  (team-scoped) may write to ANY project in its team; a project-scoped key is
  restricted to that one project.

## Gaps This Spec Closes

1. **Context read is local-only** — `src/cli/handlers/context.ts:29` always calls
   `/api/context/inject` on the local worker. No client branch.
2. **Single fixed project** — `runtime-selector.ts` resolves one
   `CLAUDE_MEM_SERVER_BETA_PROJECT_ID`; no per-repo mapping.
3. **No offline durability** — client failures currently fall back to the local
   worker/SQLite instead of spooling.
4. **No clean client-only / server-only install** — no `--mode`, no thin-client
   packaging, no team-scoped enrollment.
5. **No name-based project resolution** — `projects` lacks `UNIQUE (team_id, name)`
   (`schema.ts:94` only `UNIQUE(id, team_id)`); no resolve-or-create endpoint.

## Architecture

```
[laptop]    claude-mem(client) ─┐
[desktop]   claude-mem(client) ─┼─ Tailscale/HTTPS → [omarchy-bj2] claude-mem(server)
[omarchy]   (client, loopback) ─┘                       Postgres + Valkey + worker(generation)
```

- **client**: no local memory DB or generation; hooks call remote `/v1/*`. No
  provider key needed (generation runs server-side).
- **server**: existing Docker + systemd stack; single source of truth for all
  clients (remote and the loopback client on the same host).

### Write flow (PostToolUse, session lifecycle)

```
hook → resolveRuntimeContext() = client
     → resolve projectId from repo name (local cache or server resolve)
     → POST /v1/events (generate=true)        ── success: done
                                               └ eligible failure: append to ~/.claude-mem/spool/pending.ndjson
next hook entry → flush spool first (replay) → then do current work
```

### Read flow (SessionStart context injection)

```
hook(context) → client → POST /v1/context { projectId, query, limit }
              → inject remote observations into the prompt   (offline → skip silently)
```

### Generation

Client sends raw events only. The server worker container consumes BullMQ,
compresses/summarizes, and writes observations to Postgres. **Client needs no
`ANTHROPIC_API_KEY`.**

## Components

### 1. Project resolver — `src/services/hooks/project-resolver.ts` (new)

- `resolveProjectId(cwd, client) → uuid`.
- Repo name = `basename(cwd)` (reuse the rule from `user-message.ts:14`).
- Cache name→UUID in `~/.claude-mem/project-map.json`; on miss call
  `POST /v1/projects/resolve { name }` and persist.
- Used by every client-mode hook handler.

### 2. Runtime selector changes — `runtime-selector.ts`

- Add `'client'` runtime value (alias of the server-beta client path).
- Client context exposes `{ runtime:'client', client, resolveProjectId }`.
- Drop the hard requirement on `CLAUDE_MEM_SERVER_BETA_PROJECT_ID`. If a fixed
  `PROJECT_ID` is configured, honor it as a "single shared pool" override
  (backward compatible).

### 3. Hook handler branches — all paths support client

| Handler | Current | Change |
|---|---|---|
| `observation.ts` (PostToolUse) | server-beta branch | projectId via resolver; on eligible failure → **spool** (replaces worker fallback) |
| `session-init.ts` (UserPromptSubmit) | server-beta branch | same |
| `context.ts` (SessionStart) | **local only** | **new client branch** → `client.getContextObservations()` (`/v1/context`) |
| `file-context.ts` (PreToolUse Read) | worker-only (`executeWithWorkerFallback`) | **no-op in client mode for v1** — an optional pre-read enhancement; session-start `/v1/context` already injects memory. Future: wire to `/v1/search` by file path (out of scope). |
| `summarize.ts` (Stop) | endSession exists | `client.endSession()` branch; on failure → spool |

In client mode the local worker / SQLite / Chroma are never started.

### 4. Offline spool + sync — `src/services/hooks/spool.ts` (new)

- File: `~/.claude-mem/spool/pending.ndjson` (one JSON record per line).
- Record: `{ id(uuid), kind, endpoint, body, projectName, enqueuedAtEpoch, attempts }`.
  Store `projectName` (not UUID) — UUID may be unknown while offline; resolve at
  flush time.
- **Append on eligible failure** (timeout/ECONNREFUSED/5xx/429). 4xx is a
  permanent failure → log + drop (401/403 also raise a one-time warning).
  Append-only with `O_APPEND` single line → concurrent-hook safe, no lock.
- **Flush** at the start of the next hook invocation and at SessionStart:
  atomically rename `pending.ndjson` → `flushing.<pid>.ndjson` (take), replay FIFO,
  resolve `projectName`→UUID, POST. Successes drop; eligible re-failures are
  re-appended to `pending.ndjson`; permanent failures drop + log.
- **Idempotency:** send the record `id` as the event idempotency key so server-side
  `UNIQUE(idempotency_key)` (`schema.ts:172`) absorbs duplicate replays.
- **Bounds:** max 5,000 lines or 50MB (configurable); over → drop oldest + one
  warning. Per-hook flush budget: max 200 records or ~2s; overflow carries to the
  next hook (never block the session).
- Reads/context are NOT spooled — offline simply skips injection.

### 5. Server: project resolve + provisioning

- **`POST /v1/projects/resolve { name } → { id }`** (writeAuth, `memories:write`):
  ```sql
  INSERT INTO projects (id, team_id, name) VALUES (gen_random_uuid(), $team, $name)
  ON CONFLICT (team_id, name) DO UPDATE SET name = EXCLUDED.name
  RETURNING id;
  ```
  Requires a team-scoped key (`project_id NULL`).
- **Migration:** add `UNIQUE (team_id, name)` to `projects` (guard: de-dupe any
  existing same-name rows first).
- **`claude-mem server enroll [--label <device>]`** (new CLI): create a
  team-scoped key (`project_id=NULL`, scopes `memories:read,memories:write`) reusing
  existing api-key creation; print an **enrollment string** =
  `base64url({url, key})`.
  - Note: existing `server api-key list` is broken (`last_used_at` missing); enroll
    uses create only. Fix or avoid `list` opportunistically.

### 6. Install — `src/npx-cli/commands/install.ts`

- `--mode` takes precedence over `--runtime`. Mapping:
  `server → runtime=server-beta (+ provisioning)`, `client → runtime=client (thin)`,
  unspecified → existing interactive/worker default (backward compatible).
- **Server install** `--mode server [--with-local-client]`:
  ensure Docker + systemd stack → bootstrap schema + migration → ensure default
  team + issue first enrollment key → print enrollment string. Install IDE hooks
  only with `--with-local-client` (default on for this single-box scenario).
- **Client install** `--mode client --enroll <token>` (or `--server-url <url>
  --token <key>`): write settings (`CLAUDE_MEM_RUNTIME=client`, URL, KEY) → install
  IDE hooks → preflight (`GET /v1/info` reachability + key check) → projects resolve
  lazily on first use. No local worker/SQLite/Chroma; no provider-key step.
  Preflight failure warns but still completes (offline laptop installs fine; spool
  handles it).
- `claude-mem uninstall --mode client` removes hooks/settings/spool; server data
  untouched. Mode switches are handled by reinstall.

## Config Surface (client)

```
CLAUDE_MEM_RUNTIME=client                 # new value (alias of server-beta client path)
CLAUDE_MEM_SERVER_BETA_URL=https://100.77.250.118:37700
CLAUDE_MEM_SERVER_BETA_API_KEY=<team-scoped key>
# CLAUDE_MEM_SERVER_BETA_PROJECT_ID         # optional; if set, forces a single pool
```

Files are `0600`: `.env`, `project-map.json`, spool.

## Error Handling — invariant: hooks never block the session

- Every remote call: short timeout + try/catch. Eligible failures spool; 4xx
  permanently drop (401/403 → one-time warning). Context read failure → empty
  context, continue. Hook exit code always 0. Spool flush errors are swallowed and
  carried to the next hook.

## Security

- Trusted Tailscale network assumption retained; prefer `https` in URLs. Server
  keeps api-key auth; team-scoped client keys carry only `memories:read,write`.
- Enrollment token embeds the plaintext key → one-time print, paste over a trusted
  channel. The `DOCKER-USER` FORWARD allow for Tailscale is already applied on this
  host.

## Testing

- **Unit (no DB):** `project-resolver` (cache hit/miss), `spool`
  (append / atomic take / FIFO replay / 4xx drop / bound trimming), enrollment
  token encode/decode.
- **Integration (Postgres-gated, `CLAUDE_MEM_TEST_POSTGRES_URL`):**
  `/v1/projects/resolve` idempotency (concurrent ×2 → same UUID); team-scoped key
  writes to multiple projects; project-scoped key rejected; migration unique
  constraint.
- **Handlers:** `context.ts` client branch calls `/v1/context` (client mock);
  observation failure → spool → next-call flush round-trip.
- **E2E (manual/Docker):** laptop=client, omarchy-bj2=server. Offline (server stop)
  → observations spool → server start → auto-sync → appears in the viewer.

## Rollout / Backward Compatibility

Existing `worker` / `server-beta` installs keep working; `client` is a new runtime
alias. Order: ① server `/v1/projects/resolve` + migration → ② client runtime
(resolver + context branch) → ③ spool/sync → ④ install `--mode` → ⑤ enroll CLI →
⑥ E2E verification.

## Out of Scope

- Multi-tenant / team onboarding UI, key-rotation UX, rate limiting.
- Hybrid local cache of reads; background sync daemon (approach B).
- Changing existing worker (local) mode behavior.
