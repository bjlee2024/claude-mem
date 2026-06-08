# Plan: Server-side Token Economics (server-beta)

**Date:** 2026-06-08 · **Fork:** `@bjlee2024/claude-mem`
**Goal:** persist per-observation generation token counts in server-beta Postgres, expose an aggregation endpoint, and re-enable the timeline-report "Token Economics & Memory ROI" section in client/server mode (currently omitted).

## Headline finding (changes the shape of the work)

Token **capture is already 90% built**: `ServerGenerationResult.tokensUsed?: number` exists and **every provider already extracts and returns it** (Claude via `parseClaudeMessagesResponse`, Gemini `usageMetadata.totalTokenCount`, OpenRouter/Ollama `usage.total_tokens`). The **only leak** is `ProviderObservationGenerator.process()` reading `result.tokensUsed` but not passing it to `processGeneratedResponse`. So this is mostly *plumbing + storage + an endpoint*, not new provider work.

**Honest limitation (document in the skill):** historical observations have NO token data — the column will be NULL until they are regenerated. Server-mode Token Economics reflects only observations generated AFTER this ships. No backfill is possible (the data was never captured).

---

## Phase 0 — Discovery (Allowed APIs / facts)

**Schema & migration** — `src/storage/postgres/schema.ts`:
- `observations` CREATE TABLE `:212-227`; `observation_generation_jobs` `:177-210`. All use `CREATE TABLE IF NOT EXISTS`.
- **Additive-migration idiom already in use** `:258-269`: `ALTER TABLE observations ADD COLUMN IF NOT EXISTS content_search …`, `ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS platform_source TEXT`, etc.
- `bootstrapServerBetaPostgresSchema` `:22-49` runs `PHASE_1_SCHEMA_SQL` in a transaction + records `server_beta_schema_migrations` (version `SERVER_BETA_POSTGRES_SCHEMA_VERSION = 1`, `:5`). Called at every server/worker startup via `create-server-beta-service.ts:307` (`initializePostgres`). Idempotent.
- Row types + mappers: `PostgresObservation` / `ObservationRow` (`src/storage/postgres/observations.ts:17-30,43-56`), `mapObservationRow` `:382-397`, `create()` INSERT `~:90-120`.

**Capture** — providers (no change needed):
- `ServerGenerationResult` `src/server/generation/providers/shared/types.ts:23-28` already has `tokensUsed?: number`.
- Claude: `providers/shared/claude-messages.ts:42-46` sums `input_tokens+output_tokens`. Gemini `GeminiObservationProvider.ts:126-135`. OpenRouter `OpenRouterObservationProvider.ts:145-152`.
- **Leak point:** `ProviderObservationGenerator.ts:200-227` builds `persistInput` from `result` but omits `result.tokensUsed`.
- Persist site: `processGeneratedResponse.ts` observation INSERT `:130-149` (metadata object), job-event details `:211-225`; session-summary flow `~:468-475`. `ProcessGeneratedResponseInput` `:46-60`.
- Worker parity: worker stores `discovery_tokens` = input+output for that generation (`src/services/worker/ClaudeProvider.ts:304-326`). Server `tokensUsed` is the same quantity.

**Endpoint & consumption**:
- `GET /api/stats` viewer route `src/server/runtime/ServerViewerDataRoutes.ts:255-283` (no auth) + registration `:131-152` (copy template).
- `/v1/*` auth route pattern `src/server/routes/v1/ServerV1PostgresRoutes.ts:133-149` (`readAuth`, `requireTeamId`, `ensureProjectAllowed`); `/v1/timeline` handler is the closest copy template.
- Repo query pattern `observations.ts:133-151` (param SQL via `this.client.query`).
- Client: `ServerBetaClient.timelineObservations` `server-beta-client.ts:188-298` (copy for a `tokenEconomics` method). CLI consumption: `runTimelineCommand` `src/npx-cli/commands/runtime.ts:293-370` (copy for a `token-economics` subcommand).
- Skill gating to remove: `plugin/skills/timeline-report/SKILL.md` Step 4 "Token Economics (section 8) is worker-mode only".

**Anti-patterns to avoid:**
- Do NOT add a column with a non-null DEFAULT on a big table (triggers a table rewrite) — use a **nullable** `INTEGER` (no default), matching the existing idiom.
- Do NOT store tokens only in JSONB `metadata` if you need aggregation — a real `INTEGER` column is indexable and avoids `CAST(metadata->>'…' AS INTEGER)` fragility. (Decision below: dedicated column.)
- Do NOT touch the worker SQLite path — worker Token Economics already works; this is server-only.
- Do NOT attempt a historical backfill — the data does not exist.

---

## Decisions

1. **Storage:** add a dedicated nullable column **`observations.generation_tokens INTEGER`** (not JSONB). Cleaner SUM/ORDER BY, indexable, matches worker's `discovery_tokens` semantics. Bump `SERVER_BETA_POSTGRES_SCHEMA_VERSION` 1→2 with a description.
2. **Endpoint:** new **`POST /v1/token-economics`** (auth `memories:read`), mirroring `/v1/timeline`. (Optionally also surface totals in `/api/stats` for the viewer — Phase 3b, optional.)
3. **Consumption:** new CLI **`claude-mem token-economics [--project]`** mirroring `timeline`, so the skill shells out the same way.

---

## Phase 1 — Schema: add `generation_tokens` column (safe additive)

**File:** `src/storage/postgres/schema.ts`, `src/storage/postgres/observations.ts`

1. In `PHASE_1_SCHEMA_SQL`, next to the existing `ALTER TABLE … ADD COLUMN IF NOT EXISTS` block (`:258-269`), add:
   `ALTER TABLE observations ADD COLUMN IF NOT EXISTS generation_tokens INTEGER;`
2. Bump `SERVER_BETA_POSTGRES_SCHEMA_VERSION` to `2`; update the migration `description`.
3. `ObservationRow` += `generation_tokens: number | null`; `PostgresObservation` += `generationTokens: number | null`; `mapObservationRow` += `generationTokens: row.generation_tokens`.
4. `create()` input += optional `generationTokens?: number | null`; add `generation_tokens` to the INSERT column list + values (default `null`).

**Verification:** `bun test tests/storage/postgres` (if a test DB is configured); typecheck; grep that the ALTER uses `IF NOT EXISTS`. Manual: after container rebuild, `\d observations` shows the column.
**Anti-pattern guard:** `rg "ADD COLUMN IF NOT EXISTS generation_tokens"` present; no `DEFAULT` on it.

## Phase 2 — Capture: thread `tokensUsed` to persistence

**Files:** `src/server/generation/ProviderObservationGenerator.ts`, `src/server/generation/processGeneratedResponse.ts`

1. `ProviderObservationGenerator.ts:214-223`: add `tokensUsed: result.tokensUsed` to `persistInput`.
2. `ProcessGeneratedResponseInput` (`processGeneratedResponse.ts:46-60`): add `tokensUsed?: number`.
3. Observation INSERT (`:130-149`): pass `generationTokens: input.tokensUsed ?? null` to `obsRepo.create(...)`. (If a job yields multiple observations, attribute the job's `tokensUsed` to the batch — store on each, or divide; simplest: store the same job-level `tokensUsed` on each observation and dedupe in aggregation by job. Decision: store per-observation = `tokensUsed` only on the FIRST observation of the job, `null` on the rest, so SUM is exact. Document this.)
4. Job-event details (`:211-225`) and session-summary flow (`~:468-475`): add `tokensUsed: input.tokensUsed ?? null` for observability.

**Verification:** unit test in `tests/server/generation/` asserting a stubbed provider returning `tokensUsed: 123` results in `generation_tokens=123` persisted (needs test DB) OR a focused test on the `persistInput` wiring with a mocked repo capturing the `create` arg. typecheck + build.
**Anti-pattern guard:** `rg "tokensUsed" src/server/generation/ProviderObservationGenerator.ts` shows it threaded.

## Phase 3 — Aggregation endpoint + client + CLI

**Files:** `src/storage/postgres/observations.ts`, `src/server/routes/v1/ServerV1PostgresRoutes.ts`, `src/services/hooks/server-beta-client.ts`, `src/npx-cli/commands/runtime.ts` (+ `index.ts`)

1. Repo `aggregateTokens({projectId, teamId})` → returns `{ total: {generationTokens, observationCount}, byMonth: [{month, tokens, observationCount}], topByCost: [{id, kind, title, tokens, createdAtEpoch}] }`. SQL: `SUM(generation_tokens)`, `COUNT(*) WHERE generation_tokens IS NOT NULL`, `GROUP BY date_trunc('month', created_at)`, and a `ORDER BY generation_tokens DESC NULLS LAST LIMIT 5`. (Reads the real column, not JSONB.)
2. Route `POST /v1/token-economics` (copy `/v1/timeline` block): `readAuth`, `requireTeamId`, `ensureProjectAllowed`, body `{ projectId }`, call `repo.aggregateTokens`, `auditRead('token_economics.read', …)`, respond JSON.
3. `ServerBetaClient.tokenEconomics({projectId})` → `POST /v1/token-economics` (copy `timelineObservations`).
4. CLI `token-economics` subcommand (copy `runTimelineCommand`): client/server → resolve projectId, call `client.tokenEconomics`, print JSON; worker → print "worker mode: use the local SQLite path" or proxy. Register in `index.ts`.

**Verification:** route test mirroring `tests/server/runtime/timeline-mode.test.ts` (seed observations with `generation_tokens`, assert aggregate); CLI smoke against the live server returns JSON; typecheck/build.

## Phase 4 — Skill: re-enable Token Economics in client/server mode

**File:** `plugin/skills/timeline-report/SKILL.md`

- Replace the "Token Economics is worker-mode only / OMIT in client/server" gating (Step 4) with: in client/server mode, fetch `npx @bjlee2024/claude-mem token-economics --project <name>` and render section 8 from it (total tokens, monthly breakdown, top-N costly observations).
- Add the caveat: "Server-mode token data covers only observations generated since token capture shipped (v13.4.x); older observations show no token cost."

**Verification:** `rg "token-economics" plugin/skills/timeline-report/SKILL.md`; manual run produces a populated section.

## Phase 5 — Deploy + verify (live)

1. `npm run build`; rebuild containers `docker compose -f docker-compose.my.yml up -d --build claude-mem-server claude-mem-worker` (schema auto-migrates on boot — column appears).
2. Generate a fresh observation (trigger a session-end or post an event), then `SELECT generation_tokens FROM observations ORDER BY created_at DESC LIMIT 5;` → non-null on new rows.
3. `npx @bjlee2024/claude-mem token-economics --project claude-mem` → JSON with totals.
4. Run timeline-report in client mode → Token Economics section present.
5. Full suite no new failures; typecheck clean.

**Rollback:** the column is additive + nullable; to revert, stop writing it (revert Phase 2) — the column can stay (harmless) or be dropped (`ALTER TABLE observations DROP COLUMN generation_tokens`). Worker mode is untouched throughout.

---

## Effort / risk

- **Low-risk:** Phases 1–2 are small (additive column + thread one field; providers already done). Phase 3 copies existing route/client/CLI patterns. Phase 4 is a skill edit.
- **Main caveat:** no historical backfill — communicate clearly in the skill output.
- **Schema migration** is the only "production DB" touch; it's additive/nullable/idempotent and matches the existing bootstrap idiom, so it auto-applies safely on container restart.
