# Plan: Make memory-data skills work in client/server-beta runtime

**Date:** 2026-06-06 · **Fork:** `@bjlee2024/claude-mem`
**Problem:** In `client`/`server-beta` runtime only `mem-search` (MCP `search` → `/v1/search`) works. `timeline-report` and `weekly-digests` hit the local worker (`curl localhost:${WORKER_PORT}/api/context/inject`) and local SQLite (`~/.claude-mem/claude-mem.db`) directly → empty in client mode. `knowledge-agent` uses Chroma/worker-only corpus tools that don't exist server-side.

**Goal:** timeline-report + weekly-digests produce a real report in client mode; knowledge-agent fails gracefully with guidance. Worker mode behavior is unchanged.

---

## Scope decisions (confirm before executing)

1. **Full-timeline server endpoint:** add a NEW `POST /v1/timeline` (paginated, returns all observations incl. `kind='summary'`) rather than overloading `/v1/context`. Reason: `/v1/context` is capped at `limit ≤ 50` and is search/recent-oriented; a timeline needs full pagination and chronological order.
2. **Token Economics section (timeline-report):** **gracefully OMITTED in client/server mode.** The Postgres schema has no `discovery_tokens`, `source_tool`, `source_input_summary`, or `prompt_number`, and provider token counts are never persisted (confirmed Phase 0). Full server-side token economics = a separate schema-migration + capture-pipeline effort → **future phase, out of scope here.**
3. **knowledge-agent:** **gate corpus tools in server/client mode** with a helpful message (Option C). A `/v1/search`-based client-side "brain" (Option B) and a server-side corpus (Option A) are noted as future work, out of scope here.

If you want token-economics-on-server or server-side corpora included, that expands scope materially (see "Future phases").

---

## Phase 0 — Discovery findings (Allowed APIs / anti-patterns)

**Server route registration template** — `src/server/routes/v1/ServerV1PostgresRoutes.ts:919-965` (`/v1/context`) and `:877-909` (`/v1/search`). Pattern: `app.post(path, readAuth, this.handleCreate(zodSchema, async (req,res,body)=>{ const teamId=this.requireTeamId(req,res); if(!teamId)return; if(!this.ensureProjectAllowed(req,res,body.projectId))return; ... res.status(200).json({...}); }))`. `readAuth` = `requirePostgresServerAuth(pool,{requiredScopes:['memories:read']})` (`:145`).

**serializeObservation** — `ServerV1PostgresRoutes.ts:1731-1753`. Emits: `id, projectId, teamId, serverSessionId, kind, content, metadata, createdAtEpoch, updatedAtEpoch`. Reuse as-is.

**Repository** — `src/storage/postgres/observations.ts`:
- `listByProject({projectId, teamId, serverSessionId?, limit?})` `:133-151` — SQL `SELECT * FROM observations WHERE project_id=$1 AND team_id=$2 AND ($3::text IS NULL OR server_session_id=$3) ORDER BY created_at DESC LIMIT $4`. **No OFFSET, no kind filter.** Returns all kinds (incl. summary).
- `listRecent` `:173-185` delegates to `listByProject`. `search` `:153-171` is FTS.
- `PostgresObservation` type `:17-30`: `{id, projectId, teamId, serverSessionId, kind, content, generationKey, metadata, embedding, createdByJobId, createdAtEpoch, updatedAtEpoch}`.

**ServerBetaClient** — `src/services/hooks/server-beta-client.ts:211-290`. Methods: `searchObservations→POST /v1/search`, `contextObservations→POST /v1/context`, `resolveProject→POST /v1/projects/resolve`, etc. Auth header `Authorization: Bearer ${apiKey}` (`:369`). `buildSearchPayload` builds `{projectId, query, limit?}` (`:316`).

**CLI client-mode template** — `src/npx-cli/commands/runtime.ts:186-282` (`search`). Resolves runtime via `selectRuntime()`; builds `buildClientRuntimeContext()`/`buildServerBetaContext()`; resolves projectId via `new ProjectResolver({client, mapPath: join(DATA_DIR,'project-map.json')}).resolve(process.cwd())`; calls client; prints `JSON.stringify(data,null,2)`. **Copy this structure.**

**Skill worker-mode bash** — `plugin/skills/timeline-report/SKILL.md:25-31` (worker-port resolve), `:39-52` (worktree-aware project name), `:61` (`curl .../api/context/inject?project=...&full=true`). `weekly-digests` mirrors at `:31-34,:58`.

**corpus tools** — `src/servers/mcp-server.ts:849-953` register `build_corpus/list_corpora/prime_corpus/query_corpus/rebuild_corpus/reprime_corpus`; handlers unconditionally `callWorkerAPI(...)` with **no `selectRuntime()` branch** (contrast `search` tool `:515`). Tools list is static (`:968-975`) — exposed in all runtimes. Server has no `/v1/corpus`.

**Anti-patterns to avoid:**
- Do NOT add `offset` by string-concatenating SQL — use a parameter (`$5`).
- Do NOT invent `/v1/context?full=true` — `/v1/context` caps `limit≤50`; use the new `/v1/timeline`.
- Do NOT try to read `discovery_tokens`/`source_tool` from server data — they don't exist (Phase 0).
- Do NOT have skills curl the server directly with hand-rolled auth/projectId — shell out to the CLI subcommand (Phase 2) which already handles runtime/auth/projectId/pagination.
- Do NOT filter the corpus tools out of the MCP tools list (breaks discovery); gate inside the handlers like `search` does.

---

## Phase 1 — Server: paginated full-timeline read path

**Files:** `src/storage/postgres/observations.ts`, `src/server/routes/v1/ServerV1PostgresRoutes.ts`, `src/services/hooks/server-beta-client.ts`

1. **Repo:** add optional `offset?: number` to `listByProject` input and SQL (`... ORDER BY created_at DESC LIMIT $4 OFFSET $5`, default 0). Keep existing callers working (offset defaults to 0). Add a thin `listAllForTimeline({projectId, teamId, limit, offset})` OR just reuse `listByProject` (decision: reuse `listByProject` with offset — minimal surface).
2. **Route:** add `POST /v1/timeline` by COPYING the `/v1/context` block (`:919`). Body zod: `{ projectId: z.string().min(1), limit: z.number().int().positive().max(500).optional(), offset: z.number().int().nonnegative().optional() }`. Handler: `requireTeamId` + `ensureProjectAllowed`, `repo.listByProject({projectId, teamId, limit: body.limit??200, offset: body.offset??0})`, `auditRead(req,'timeline.read',...)`, respond `{ observations: results.map(serializeObservation), hasMore: results.length === (body.limit??200) }`. (Chronological assembly is done client-side after paginating; keep DESC from the repo and reverse in the consumer, or document order.)
3. **Client:** add `timelineObservations({projectId, limit?, offset?})` to `ServerBetaClient` (copy `contextObservations` `:261-269`) → `POST /v1/timeline`, returning `{ observations: ServerBetaObservation[], hasMore: boolean }`. Add the response/request TS interfaces next to the existing ones.

**Verification:** `bun test tests/server` (add a `/v1/timeline` route test mirroring the `/v1/context` recent-mode test in `tests/server/runtime/context-recent-mode.test.ts`); typecheck clean; manual `curl -XPOST .../v1/timeline -H "Authorization: Bearer …" -d '{"projectId":"…","limit":5}'` returns observations.
**Anti-pattern guard:** `rg -n "OFFSET" src/storage/postgres/observations.ts` shows a parameterized `$5`, not interpolation.

---

## Phase 2 — CLI: client-aware `timeline` subcommand

**File:** `src/npx-cli/commands/runtime.ts` (+ registration in `src/npx-cli/index.ts`)

1. Add a `timeline` subcommand by COPYING the `search` client block (`:186-282`). In `worker` runtime → keep behavior parity by calling the worker `/api/context/inject?project=…&full=true` (or print a clear "use worker skill path" note — decision: in worker mode the skills already curl directly, so the CLI command only needs the client/server branch; in worker mode print a short message or proxy to the worker). In `client`/`server-beta` → resolve projectId via `ProjectResolver`, loop `client.timelineObservations({projectId, limit:200, offset})` until `hasMore===false`, accumulate, sort by `createdAtEpoch` ascending, print `JSON.stringify({observations}, null, 2)`.
2. Flags: `--project <name>` (override cwd resolution), `--json` (default on for client mode).

**Verification:** in a client-mode setup, `npx @bjlee2024/claude-mem timeline --json` prints the project's observations from the server; `tests/cli` add a unit test stubbing the client (mirror `tests/cli/handlers/*-client.test.ts` mocking pattern).
**Anti-pattern guard:** no direct SQLite/`claude-mem.db` access in the new command.

---

## Phase 3 — Skills: timeline-report + weekly-digests runtime branches

**Files:** `plugin/skills/timeline-report/SKILL.md`, `plugin/skills/weekly-digests/SKILL.md`

1. Add an early **runtime detection** step (read `CLAUDE_MEM_RUNTIME` from `~/.claude-mem/settings.json`, default `worker`):
   - `worker` → existing flow unchanged (worker port resolve + `curl /api/context/inject?...&full=true`).
   - `client`/`server-beta` → fetch the timeline by shelling out to `npx @bjlee2024/claude-mem timeline --project <name> --json` (Phase 2), then build the report from the returned JSON observations (title/narrative/facts/concepts/files from `metadata`, time from `createdAtEpoch`).
2. **timeline-report Token Economics:** wrap that section in "worker mode only". In client/server mode, emit a one-line note: "Token Economics is unavailable in server/client mode (token data is not persisted server-side)." Remove the `sqlite3 ~/.claude-mem/claude-mem.db` instructions from the client branch (keep them only under the worker branch).
3. Update the skills' "Empty timeline / worker not running" troubleshooting to be runtime-aware (client mode → check server URL/key/reachability via `npx @bjlee2024/claude-mem client status`).

**Verification:** `rg -n "localhost:|claude-mem\.db|WORKER_PORT" plugin/skills/timeline-report/SKILL.md plugin/skills/weekly-digests/SKILL.md` shows those refs ONLY under the worker-mode branch; the client branch references the CLI subcommand. Manual: run each skill in a client-mode repo and confirm a report is produced from server data.
**Anti-pattern guard:** client branch contains zero `localhost`/`.db` references.

---

## Phase 4 — knowledge-agent: gate corpus tools in server/client mode

**Files:** `src/servers/mcp-server.ts`, `plugin/skills/knowledge-agent/SKILL.md`

1. In each of the 6 corpus handlers (`:869-952`), add a runtime check COPYING the `search` tool's branch shape (`:515` / the timeline/get_observations "unavailable" message `:555`): if `selectRuntime() !== 'worker'`, return `{ content:[{type:'text', text:'Corpus / knowledge-agent tools require worker runtime; they are not available in server/client mode yet. Use the `search` MCP tool (mem-search) for memory recall.'}] }` (NOT `isError`, so it reads as guidance). Keep the tools registered (don't filter the list).
2. `knowledge-agent/SKILL.md`: add a note at top — "Worker runtime only. In server/client mode use `mem-search`." 

**Verification:** `rg -n "selectRuntime" src/servers/mcp-server.ts` shows checks inside corpus handlers; in client mode invoking `build_corpus` returns the guidance message, not a worker connection error.

---

## Phase 5 — Build, test, verify

1. `npm run build` (regenerates `mcp-server.cjs`, `server-beta-service.cjs`, npx-cli) — clean.
2. `npx tsc --noEmit` — clean.
3. `bun test tests/server tests/cli tests/hooks` — new `/v1/timeline` + CLI timeline tests pass; no regressions vs the documented baseline (4 pre-existing full-suite ordering failures, see commit 8b2d588d notes).
4. Manual client-mode smoke: in a repo enrolled to a server, run timeline-report and weekly-digests → report produced from server data; knowledge-agent → guidance message; `npx @bjlee2024/claude-mem timeline --json` → observations.
5. Sync skills to the cache so the installed plugin reflects changes (`npm run build-and-sync`, or push + reinstall).

---

## Future phases (out of scope; flagged for later)

- **Server-side Token Economics:** Postgres migration to persist per-observation token counts + `source_tool`/`prompt_number`, capture provider `input_tokens/output_tokens` at generation time (`src/server/generation/providers/*`), aggregate via a `/v1/stats` route. Then re-enable the Token Economics section in server mode.
- **knowledge-agent on server:** Option A (server-side corpus table + `/v1/corpus/*` + Chroma bridge) or Option B (ephemeral client-side brain rebuilt from `/v1/search`).
