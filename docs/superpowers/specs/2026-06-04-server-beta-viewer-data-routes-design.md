# server-beta Viewer Data Routes — Design

**Date:** 2026-06-04
**Status:** Approved (design), pending spec review
**Author:** bjlee + Claude

## Problem

The `docker-compose.my.yml` stack runs the **server-beta** runtime. It serves the
web viewer (`viewer-bundle.js`) as static files via `ServerViewerRoutes.ts`, but
the viewer's data API (`/api/observations`, `/api/summaries`, `/api/stats`,
`/api/projects`, `/api/processing-status`, `/api/prompts`, `/api/settings`) is
**not implemented** in server-beta — those endpoints exist only in the legacy
worker runtime (`src/services/worker/http/routes/DataRoutes.ts`, SQLite-backed).
Every viewer data fetch returns 404, so the viewer is stuck on "Loading more..."
with no content.

Goal: a **shared Postgres server** (server-beta) whose web viewer shows the same
content a local worker-runtime viewer shows. This is impossible by configuration —
the routes do not exist. It requires implementing the viewer's read API in
server-beta, backed by Postgres.

## Goals

- Implement the read-only data endpoints the viewer needs, backed by Postgres.
- Viewer bundle stays **unchanged**; only the server-beta backend gains routes,
  then we rebuild.
- Response shapes match exactly what the viewer consumes (`{ items, hasMore }`
  pagination; the `Observation` shape with `JSON`-stringified array fields).

## Non-Goals (YAGNI)

- No write endpoints (`POST /api/processing`, `/api/import`, `/api/settings`
  updates, MCP/branch routes).
- No authentication on these routes — read-only, public (per decision: trusted
  Tailscale tailnet; viewer's `authFetch` sends no credentials anyway).
- No real `/api/prompts` data (server-beta does not store user prompts in the
  viewer's shape) — return an empty page.
- No team/tenant scoping in the UI — return the owner's data across all
  teams/projects (single-owner deployment).
- Live SSE (`/stream`) is **optional** (see Open Questions); a no-op keepalive is
  acceptable to stop EventSource retry noise.
- Detail/batch endpoints (`/api/observation/:id`, `/api/observations/batch`,
  `/api/observations/by-file`, `/api/session/:id`) are out of scope for the
  initial feed.

## Approach

Add a new route module, mirroring the existing `ServerViewerRoutes.ts` pattern,
that registers GET routes on the server-beta Express app and reads from the
Postgres storage repositories (`createPostgresStorageRepositories(pool)`) and/or
direct pool queries.

**Mount point & auth:** registered **outside** the api-key auth middleware (these
are intentionally unauthenticated read-only routes), and **before** the static
viewer handler so the paths resolve to JSON, not the SPA fallback.

Rejected alternative: repoint the viewer bundle to the `/v1/*` API. Rejected
because `/v1` requires bearer auth (browser has none), uses different response
shapes, and would be a large frontend rewrite + rebuild. The backend-route
approach changes less and keeps the viewer untouched.

## Architecture

- **New file:** `src/server/runtime/ServerViewerDataRoutes.ts`
  - A class/function that, given the Express `app` and the Postgres pool/repos,
    registers the GET routes below.
  - Pure data mapping; no business logic beyond querying + shaping.
- **Wiring:** `ServerBetaService` mounts `ServerViewerDataRoutes` alongside
  `ServerViewerRoutes`, before static serving, outside auth.
- **Queries:** reuse `PostgresObservationRepository` where it fits; add a
  `listForViewer({ offset, limit, project? })` method (or use a direct pool query)
  for the cross-project, newest-first, `limit+1` pagination the feed needs.

## Endpoint Contracts

All responses are JSON. Pagination params: `?offset=<int>&limit=<int>&project=<name>`.

### `GET /api/observations` → `{ items: Observation[], hasMore, offset, limit }`
- Query `observations` ORDER BY `created_at` DESC, `LIMIT limit+1 OFFSET offset`;
  `hasMore = rows.length > limit`; `items = rows.slice(0, limit)` mapped.
- Optional `project` filter maps to the project **name** (join `projects`).

**Observation mapping (Postgres → viewer `Observation`):**

| viewer field | source | notes |
|---|---|---|
| `id` | `observations.id` (UUID text) | viewer type says `number`; pass string through (runtime-safe as React key / display). Flagged deviation. |
| `memory_session_id` | `server_session_id` | may be null → `""` |
| `project` | `projects.name` (via `project_id`) | viewer shows/filter by name |
| `merged_into_project` | `null` | not modeled in server-beta |
| `platform_source` | `metadata.provider` or `'claude'` | |
| `type` | `kind` | |
| `title` | `metadata.title` | |
| `subtitle` | `metadata.subtitle` | |
| `narrative` | `metadata.narrative` | |
| `text` | `content` | |
| `facts` | `JSON.stringify(metadata.facts ?? [])` | **must be JSON string** — viewer does `JSON.parse` |
| `concepts` | `JSON.stringify(metadata.concepts ?? [])` | JSON string |
| `files_read` | `JSON.stringify(metadata.files_read ?? [])` | JSON string |
| `files_modified` | `JSON.stringify(metadata.files_modified ?? [])` | JSON string |
| `prompt_number` | `null` | not modeled |
| `created_at` | `created_at` ISO | |
| `created_at_epoch` | `created_at`.getTime() | ms epoch |

### `GET /api/summaries` → `{ items, hasMore, offset, limit }`
- `observations` WHERE `kind = 'summary'`, same pagination + mapping. Likely empty
  initially; that's correct (empty page, not 404).

### `GET /api/prompts` → `{ items: [], hasMore: false, offset, limit }`
- Stub: empty page (no prompt store in viewer shape).

### `GET /api/projects` → `{ projects: string[], sources: string[], projectsBySource: Record<string,string[]> }`
- `projects.name` list. `sources = ['claude']`, `projectsBySource = { claude: projects }`.

### `GET /api/stats` → `{ version, totalObservations, totalSessions, totalSummaries, firstObservationAt }`
- Counts from `observations`, `server_sessions`, `observations WHERE kind='summary'`.
- `version` from server package.json; `firstObservationAt` = MIN(created_at) or null.

### `GET /api/processing-status` → `{ isProcessing: boolean, queueDepth: number }`
- `queueDepth` = count of `observation_generation_jobs` in pending/active states;
  `isProcessing = queueDepth > 0`.

### `GET /api/settings` → `{}`
- Return empty object; the viewer's `useSettings` applies `DEFAULT_SETTINGS` for
  every missing key, so `{}` yields safe defaults. (No settings persistence.)

### `GET /stream` (optional) → SSE keepalive
- Minimal `text/event-stream` that stays open and emits periodic comments. Prevents
  EventSource reconnect noise. No live push of new data in this iteration.

## Error Handling

- Per-route try/catch → `500 { error, message }` on query failure; never crash the
  process. Pagination params parsed defensively (NaN → defaults: offset 0,
  limit 50, clamp limit to a max e.g. 200).

## Testing (TDD)

- Integration tests against a Postgres test instance (follow existing server-beta
  test setup): seed teams/projects/observations, then assert each endpoint's JSON
  shape and the observation field mapping (esp. JSON-stringified arrays, epoch,
  project-name resolution, `hasMore` boundary at `limit+1`).
- A focused test that the routes are reachable **without** an api-key (no-auth).

## Verification

1. Unit/integration tests green.
2. `npm run build-and-sync`, rebuild the Docker image, bring the stack up.
3. Seed a few sample observations into Postgres (test script / SQL), load the
   viewer over Tailscale, confirm cards render (title, facts, files), pagination
   ("Loading more...") resolves, stats/projects populate. Remove seed rows after.
4. (Real data end-to-end requires `ANTHROPIC_API_KEY` + a connected client — out
   of scope here.)

## Rollout

- Backend-only change + rebuild. No viewer bundle change. No DB migration.
- `docker compose -f docker-compose.my.yml build && up -d`.

## Open Questions

- **`/stream`**: implement no-op SSE now, or omit and accept EventSource 404
  retries? Default: implement a minimal no-op SSE.
- **`id` type**: pass UUID string (chosen) vs synthesize a stable numeric id. Chosen
  string passthrough; revisit only if a viewer feature breaks on non-numeric id.
