# server-beta Viewer Data Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the read-only data API the bundled viewer needs (`/api/observations`, `/api/summaries`, `/api/projects`, `/api/stats`, `/api/processing-status`, `/api/prompts`, `/api/settings`, `/stream`) in the server-beta runtime, backed by Postgres, so the Docker viewer shows content instead of "Loading more...".

**Architecture:** A new `RouteHandler` (`ServerViewerDataRoutes`) registered on the server-beta Express app — outside auth, before the static viewer handler. It runs Postgres queries via the shared pool and maps rows to the exact shapes the viewer consumes (`{ items, hasMore }`; the `Observation` shape with JSON-stringified array fields). No DB migration; viewer bundle unchanged.

**Tech Stack:** TypeScript, Express, node-postgres (`pg`), Bun test runner. Spec: `docs/superpowers/specs/2026-06-04-server-beta-viewer-data-routes-design.md`.

---

## File Structure

- **Create:** `src/server/runtime/ServerViewerDataRoutes.ts` — the route handler + pure mapping helpers (`mapObservationToViewer`, `parsePagination`). Single responsibility: adapt Postgres reads to the viewer's legacy API shapes.
- **Create:** `tests/server/runtime/server-viewer-data-routes.test.ts` — Postgres-gated integration tests.
- **Create:** `tests/server/runtime/map-observation-to-viewer.test.ts` — pure unit tests (no DB) for the mapping.
- **Modify:** `src/server/runtime/ServerBetaService.ts:212` — register the new handler before `ServerViewerRoutes`.

> **Postgres-gated tests:** Integration tests run only when `CLAUDE_MEM_TEST_POSTGRES_URL` is set (same convention as `tests/server/runtime/jobs-list-and-operator-routes.test.ts`). Locally, the Docker stack's Postgres can be used, e.g.:
> `export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://admin:medit@123@127.0.0.1:5432/claudemem"` (after `docker compose -f docker-compose.my.yml up -d`).

---

## Task 1: Pure observation mapping (`mapObservationToViewer`)

Highest-risk logic (JSON-stringified arrays, epoch, null handling). Test it without a DB first.

**Files:**
- Create: `src/server/runtime/ServerViewerDataRoutes.ts`
- Test: `tests/server/runtime/map-observation-to-viewer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/runtime/map-observation-to-viewer.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { mapObservationToViewer } from '../../../src/server/runtime/ServerViewerDataRoutes.js';

describe('mapObservationToViewer', () => {
  const baseRow = {
    id: 'obs-uuid-1',
    server_session_id: 'sess-1',
    project_name: 'claude-mem',
    kind: 'observation',
    content: 'the narrative text',
    metadata: {
      title: 'Title', subtitle: 'Sub', narrative: 'N',
      facts: ['a', 'b'], concepts: ['c'],
      files_read: ['/x'], files_modified: [],
      provider: 'claude',
    },
    created_at: new Date('2026-06-04T00:00:00.000Z'),
  };

  it('maps structured metadata into JSON-stringified array fields', () => {
    const v = mapObservationToViewer(baseRow);
    expect(v.id).toBe('obs-uuid-1');
    expect(v.memory_session_id).toBe('sess-1');
    expect(v.project).toBe('claude-mem');
    expect(v.type).toBe('observation');
    expect(v.text).toBe('the narrative text');
    expect(v.title).toBe('Title');
    expect(v.facts).toBe('["a","b"]');          // viewer does JSON.parse(facts)
    expect(v.concepts).toBe('["c"]');
    expect(v.files_read).toBe('["/x"]');
    expect(v.files_modified).toBe('[]');
    expect(v.platform_source).toBe('claude');
    expect(v.created_at).toBe('2026-06-04T00:00:00.000Z');
    expect(v.created_at_epoch).toBe(Date.parse('2026-06-04T00:00:00.000Z'));
    expect(v.merged_into_project).toBeNull();
    expect(v.prompt_number).toBeNull();
  });

  it('handles missing metadata fields and null session/project as safe defaults', () => {
    const v = mapObservationToViewer({
      id: 'o2', server_session_id: null, project_name: null,
      kind: 'observation', content: 'c', metadata: {}, created_at: new Date('2026-06-04T00:00:00.000Z'),
    });
    expect(v.memory_session_id).toBe('');
    expect(v.project).toBe('');
    expect(v.platform_source).toBe('claude');   // default when no provider
    expect(v.title).toBeNull();
    expect(v.facts).toBeNull();                  // absent array -> null
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/runtime/map-observation-to-viewer.test.ts`
Expected: FAIL — `mapObservationToViewer` not exported / module not found.

- [ ] **Step 3: Create the module with the mapping + helpers**

```ts
// src/server/runtime/ServerViewerDataRoutes.ts
// SPDX-License-Identifier: Apache-2.0
//
// Viewer data API for the server-beta runtime. The bundled viewer
// (viewer-bundle.js) fetches /api/observations, /api/summaries, /api/stats,
// /api/projects, /api/processing-status, /api/prompts, /api/settings and opens
// an EventSource on /stream. Those endpoints exist only in the legacy worker
// runtime (DataRoutes.ts, SQLite). server-beta serves the static viewer but
// never implemented its read API, so the viewer was stuck on "Loading more...".
// This handler implements the read-only subset, backed by Postgres, with NO
// auth (the viewer's authFetch sends no credentials; deployment is a trusted
// tailnet). Read-only: no writes, no team/tenant scoping (single-owner server).

import type { Application, Request, Response } from 'express';
import type { RouteHandler } from '../../services/server/Server.js';
import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import { logger } from '../../utils/logger.js';

export interface ViewerObservation {
  id: string;
  memory_session_id: string;
  project: string;
  merged_into_project: string | null;
  platform_source: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

export interface ViewerObservationRow {
  id: string;
  server_session_id: string | null;
  project_name: string | null;
  kind: string;
  content: string;
  metadata: unknown;
  created_at: Date | string;
}

function asStringArrayJson(value: unknown): string | null {
  if (Array.isArray(value)) return JSON.stringify(value);
  return null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function mapObservationToViewer(row: ViewerObservationRow): ViewerObservation {
  const meta = row.metadata && typeof row.metadata === 'object'
    ? (row.metadata as Record<string, unknown>)
    : {};
  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  return {
    id: row.id,
    memory_session_id: row.server_session_id ?? '',
    project: row.project_name ?? '',
    merged_into_project: null,
    platform_source: typeof meta.provider === 'string' ? meta.provider : 'claude',
    type: row.kind,
    title: asStringOrNull(meta.title),
    subtitle: asStringOrNull(meta.subtitle),
    narrative: asStringOrNull(meta.narrative),
    text: row.content,
    facts: asStringArrayJson(meta.facts),
    concepts: asStringArrayJson(meta.concepts),
    files_read: asStringArrayJson(meta.files_read),
    files_modified: asStringArrayJson(meta.files_modified),
    prompt_number: null,
    created_at: createdAt.toISOString(),
    created_at_epoch: createdAt.getTime(),
  };
}

export function parsePagination(req: Request): { offset: number; limit: number; project?: string } {
  const offsetRaw = Number.parseInt(String(req.query.offset ?? ''), 10);
  const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  let limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 50;
  if (limit > 200) limit = 200;
  const project = typeof req.query.project === 'string' && req.query.project.length > 0
    ? req.query.project
    : undefined;
  return { offset, limit, project };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/runtime/map-observation-to-viewer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/runtime/ServerViewerDataRoutes.ts tests/server/runtime/map-observation-to-viewer.test.ts
git commit -m "feat(server): viewer observation mapping helper"
```

---

## Task 2: `ServerViewerDataRoutes` class with all GET routes

**Files:**
- Modify: `src/server/runtime/ServerViewerDataRoutes.ts` (append the class)

- [ ] **Step 1: Append the route handler class to the module**

```ts
// append to src/server/runtime/ServerViewerDataRoutes.ts

interface CountRow { count: string }

export class ServerViewerDataRoutes implements RouteHandler {
  constructor(private readonly pool: PostgresQueryable) {}

  setupRoutes(app: Application): void {
    app.get('/api/observations', (req, res) => this.handleObservations(req, res, false));
    app.get('/api/summaries', (req, res) => this.handleObservations(req, res, true));
    app.get('/api/prompts', (req, res) => {
      const { offset, limit } = parsePagination(req);
      res.json({ items: [], hasMore: false, offset, limit });
    });
    app.get('/api/projects', (req, res) => this.handleProjects(req, res));
    app.get('/api/stats', (req, res) => this.handleStats(req, res));
    app.get('/api/processing-status', (req, res) => this.handleProcessingStatus(req, res));
    app.get('/api/settings', (_req, res) => res.json({}));
    app.get('/stream', (req, res) => this.handleStream(req, res));
  }

  private async handleObservations(req: Request, res: Response, summariesOnly: boolean): Promise<void> {
    try {
      const { offset, limit, project } = parsePagination(req);
      const kindFilter = summariesOnly ? "AND o.kind = 'summary'" : '';
      const projectFilter = project ? 'AND p.name = $3' : '';
      const params: unknown[] = project ? [limit + 1, offset, project] : [limit + 1, offset];
      const result = await this.pool.query<ViewerObservationRow>(
        `SELECT o.id, o.server_session_id, p.name AS project_name, o.kind, o.content,
                o.metadata, o.created_at
           FROM observations o
           LEFT JOIN projects p ON o.project_id = p.id
          WHERE 1=1 ${kindFilter} ${projectFilter}
          ORDER BY o.created_at DESC
          LIMIT $1 OFFSET $2`,
        params
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(mapObservationToViewer);
      res.json({ items, hasMore, offset, limit });
    } catch (err) {
      logger.error('SYSTEM', 'viewer /api/observations failed', { error: String(err) });
      res.status(500).json({ error: 'InternalError', message: 'Failed to list observations' });
    }
  }

  private async handleProjects(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.pool.query<{ name: string }>(
        'SELECT name FROM projects ORDER BY name ASC'
      );
      const projects = result.rows.map(r => r.name);
      res.json({ projects, sources: ['claude'], projectsBySource: { claude: projects } });
    } catch (err) {
      logger.error('SYSTEM', 'viewer /api/projects failed', { error: String(err) });
      res.status(500).json({ error: 'InternalError', message: 'Failed to list projects' });
    }
  }

  private async handleStats(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.pool.query<{
        total_observations: string;
        total_sessions: string;
        total_summaries: string;
        first_observation_at: Date | null;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM observations) AS total_observations,
           (SELECT COUNT(*) FROM server_sessions) AS total_sessions,
           (SELECT COUNT(*) FROM observations WHERE kind = 'summary') AS total_summaries,
           (SELECT MIN(created_at) FROM observations) AS first_observation_at`
      );
      const row = result.rows[0];
      res.json({
        runtime: 'server-beta',
        totalObservations: Number(row?.total_observations ?? 0),
        totalSessions: Number(row?.total_sessions ?? 0),
        totalSummaries: Number(row?.total_summaries ?? 0),
        firstObservationAt: row?.first_observation_at
          ? new Date(row.first_observation_at).toISOString()
          : null,
      });
    } catch (err) {
      logger.error('SYSTEM', 'viewer /api/stats failed', { error: String(err) });
      res.status(500).json({ error: 'InternalError', message: 'Failed to compute stats' });
    }
  }

  private async handleProcessingStatus(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.pool.query<CountRow>(
        "SELECT COUNT(*) AS count FROM observation_generation_jobs WHERE status IN ('queued','processing')"
      );
      const queueDepth = Number(result.rows[0]?.count ?? 0);
      res.json({ isProcessing: queueDepth > 0, queueDepth });
    } catch (err) {
      logger.error('SYSTEM', 'viewer /api/processing-status failed', { error: String(err) });
      res.status(500).json({ error: 'InternalError', message: 'Failed to read processing status' });
    }
  }

  private handleStream(req: Request, res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* closed */ }
    }, 30000);
    req.on('close', () => clearInterval(keepalive));
  }
}
```

- [ ] **Step 2: Type-check / build to verify it compiles**

Run: `bun build src/server/runtime/ServerViewerDataRoutes.ts --target=node > /dev/null && echo OK`
Expected: prints `OK` (no type/syntax errors). If the project uses `tsc`, run `npx tsc --noEmit` and expect no errors in this file.

- [ ] **Step 3: Commit**

```bash
git add src/server/runtime/ServerViewerDataRoutes.ts
git commit -m "feat(server): ServerViewerDataRoutes read-only viewer API"
```

---

## Task 3: Integration test — `/api/observations` shape, mapping, pagination

**Files:**
- Create: `tests/server/runtime/server-viewer-data-routes.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/server/runtime/server-viewer-data-routes.test.ts
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { ServerViewerDataRoutes } from '../../../src/server/runtime/ServerViewerDataRoutes.js';
import { bootstrapServerBetaPostgresSchema } from '../../../src/storage/postgres/index.js';
import { logger } from '../../../src/utils/logger.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function baseServerOptions() {
  return {
    getInitializationComplete: () => true,
    getMcpReady: () => true,
    onShutdown: () => Promise.resolve(),
    onRestart: () => Promise.resolve(),
    workerPath: '',
    getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
  };
}

describe('ServerViewerDataRoutes (viewer data API)', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: pg.PoolClient;
  let schemaName: string;
  let server: Server;
  let port: number;
  let teamId: string;
  let projectId: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_viewerdata_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerBetaPostgresSchema(client);
    pool.on('connect', (c) => {
      c.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });

    teamId = crypto.randomUUID();
    projectId = crypto.randomUUID();
    await client.query("INSERT INTO teams (id, name) VALUES ($1, 'T')", [teamId]);
    await client.query('INSERT INTO projects (id, team_id, name) VALUES ($1, $2, $3)', [projectId, teamId, 'proj-a']);
    // three observations, newest last inserted; created_at spaced so ordering is deterministic
    for (let i = 0; i < 3; i++) {
      await client.query(
        `INSERT INTO observations (id, project_id, team_id, kind, content, metadata, created_at)
         VALUES ($1, $2, $3, 'observation', $4, $5, now() + ($6 || ' seconds')::interval)`,
        [
          crypto.randomUUID(), projectId, teamId, `content ${i}`,
          JSON.stringify({ title: `t${i}`, facts: [`f${i}`], concepts: [], files_read: [], files_modified: [], provider: 'claude' }),
          String(i),
        ]
      );
    }

    server = new Server(baseServerOptions());
    server.registerRoutes(new ServerViewerDataRoutes(client));
    server.finalizeRoutes();
    port = 43000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');
  });

  afterEach(async () => {
    if (server?.getHttpServer()) { try { await server.close(); } catch { /* ignore */ } }
    try { await client.query(`DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`); } catch { /* ignore */ }
    client.release();
    await pool.end();
    loggerSpies.forEach(s => s.mockRestore());
    loggerSpies = [];
  });

  it('returns {items, hasMore} with viewer-shaped, newest-first observations (no auth)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/observations?limit=2&offset=0`);
    expect(res.status).toBe(200); // reachable with NO Authorization header
    const body = await res.json() as { items: any[]; hasMore: boolean; offset: number; limit: number };
    expect(body.hasMore).toBe(true);            // 3 rows, limit 2 -> hasMore
    expect(body.items).toHaveLength(2);
    expect(body.items[0].content === undefined).toBe(true); // viewer shape uses `text`, not `content`
    expect(body.items[0].text).toBe('content 2'); // newest first
    expect(body.items[0].project).toBe('proj-a');
    expect(body.items[0].facts).toBe('["f2"]');  // JSON string
    expect(typeof body.items[0].created_at_epoch).toBe('number');
  });

  it('paginates: offset past the end yields hasMore=false', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/observations?limit=2&offset=2`);
    const body = await res.json() as { items: any[]; hasMore: boolean };
    expect(body.items).toHaveLength(1);
    expect(body.hasMore).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails (when Postgres is configured)**

Run:
```bash
export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://admin:medit@123@127.0.0.1:5432/claudemem"
bun test tests/server/runtime/server-viewer-data-routes.test.ts
```
Expected: the suite RUNS (not skipped) and FAILS only if logic is wrong. Since Task 2 implemented the route, these should actually PASS. If `CLAUDE_MEM_TEST_POSTGRES_URL` is unset the suite is SKIPPED — set it (start the Docker stack first).

> TDD note: Task 2 already implemented `/api/observations`, so this test validates it. If it fails, fix `handleObservations`/mapping until green before committing.

- [ ] **Step 3: Run to verify it passes**

Run: `bun test tests/server/runtime/server-viewer-data-routes.test.ts`
Expected: PASS (2 tests), or SKIP if no Postgres URL.

- [ ] **Step 4: Commit**

```bash
git add tests/server/runtime/server-viewer-data-routes.test.ts
git commit -m "test(server): viewer /api/observations integration tests"
```

---

## Task 4: Integration tests — stats, projects, processing-status, summaries, prompts, settings

**Files:**
- Modify: `tests/server/runtime/server-viewer-data-routes.test.ts` (add `it` cases inside the same describe)

- [ ] **Step 1: Add the failing tests**

```ts
  it('GET /api/stats returns counts', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.totalObservations).toBe(3);
    expect(body.totalSessions).toBe(0);
    expect(body.totalSummaries).toBe(0);
    expect(body.firstObservationAt).toBeTruthy();
  });

  it('GET /api/projects returns names + projectsBySource', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
    const body = await res.json() as any;
    expect(body.projects).toEqual(['proj-a']);
    expect(body.projectsBySource.claude).toEqual(['proj-a']);
  });

  it('GET /api/processing-status returns idle with no jobs', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/processing-status`);
    const body = await res.json() as any;
    expect(body).toEqual({ isProcessing: false, queueDepth: 0 });
  });

  it('GET /api/summaries returns empty page when no summary-kind rows', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/summaries?limit=10&offset=0`);
    const body = await res.json() as any;
    expect(body.items).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  it('GET /api/prompts returns an empty page (stub)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/prompts`);
    const body = await res.json() as any;
    expect(body).toEqual({ items: [], hasMore: false, offset: 0, limit: 50 });
  });

  it('GET /api/settings returns {} (viewer applies defaults)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
```

- [ ] **Step 2: Run to verify**

Run: `bun test tests/server/runtime/server-viewer-data-routes.test.ts`
Expected: all PASS (or SKIP without Postgres URL). Fix handlers if any assertion fails.

- [ ] **Step 3: Commit**

```bash
git add tests/server/runtime/server-viewer-data-routes.test.ts
git commit -m "test(server): viewer stats/projects/processing/summaries/prompts/settings"
```

---

## Task 5: Wire `ServerViewerDataRoutes` into `ServerBetaService`

**Files:**
- Modify: `src/server/runtime/ServerBetaService.ts` (import near line 22; register near line 212, BEFORE `ServerViewerRoutes`)

- [ ] **Step 1: Add the import**

At the top with the other runtime imports (next to `import { ServerViewerRoutes } from './ServerViewerRoutes.js';`):

```ts
import { ServerViewerDataRoutes } from './ServerViewerDataRoutes.js';
```

- [ ] **Step 2: Register the handler before the static viewer handler**

Replace the existing line:

```ts
    server.registerRoutes(new ServerViewerRoutes());
```

with:

```ts
    // Viewer data API (read-only, no auth) — must be registered BEFORE the
    // static viewer handler so /api/* resolves to JSON, not the SPA. Backed by
    // the same Postgres pool the rest of the runtime uses.
    server.registerRoutes(new ServerViewerDataRoutes(this.graph.postgres.pool));
    server.registerRoutes(new ServerViewerRoutes());
```

- [ ] **Step 3: Build to verify it compiles and boots**

Run: `bun test tests/server/server-beta-boot.test.ts tests/server/server-viewer-routes.test.ts`
Expected: PASS (boot + viewer-static tests still green; the new handler registers without error).

- [ ] **Step 4: Run the full server test suite**

Run: `bun test tests/server/`
Expected: PASS (Postgres-gated suites SKIP if no URL; nothing regresses).

- [ ] **Step 5: Commit**

```bash
git add src/server/runtime/ServerBetaService.ts
git commit -m "feat(server): mount viewer data routes in server-beta runtime"
```

---

## Task 6: Build, deploy, and manually verify the viewer renders

Not a code task — verification that the fix works end-to-end in the Docker stack.

- [ ] **Step 1: Build & sync, rebuild the Docker image**

```bash
npm run build-and-sync
docker compose -f docker-compose.my.yml build claude-mem-server
docker compose -f docker-compose.my.yml up -d
```

- [ ] **Step 2: Confirm endpoints respond (no auth) on the host**

```bash
curl -s -o /dev/null -w "observations=%{http_code}\n" "http://127.0.0.1:37700/api/observations?limit=5"
curl -s -o /dev/null -w "stats=%{http_code}\n" "http://127.0.0.1:37700/api/stats"
curl -s -o /dev/null -w "projects=%{http_code}\n" "http://127.0.0.1:37700/api/projects"
```
Expected: all `200` (previously `404`).

- [ ] **Step 3: Seed sample observations and confirm cards render**

```bash
docker exec claude-mem-postgres-1 psql -U admin -d claudemem -c "
WITH t AS (INSERT INTO teams (id,name) VALUES (gen_random_uuid(),'demo') RETURNING id),
     p AS (INSERT INTO projects (id,team_id,name) SELECT gen_random_uuid(), id, 'demo-proj' FROM t RETURNING id, team_id)
INSERT INTO observations (id, project_id, team_id, kind, content, metadata)
SELECT gen_random_uuid(), p.id, p.team_id, 'observation', 'seeded narrative',
       '{\"title\":\"Seeded\",\"subtitle\":\"sub\",\"narrative\":\"n\",\"facts\":[\"fact one\"],\"concepts\":[\"idea\"],\"files_read\":[\"/a\"],\"files_modified\":[],\"provider\":\"claude\"}'::jsonb
FROM p;"
```
Then open the viewer over Tailscale (`http://100.77.250.118:37700/`). Expected: a card titled "Seeded" with a fact; "Loading more..." resolves; stats/projects populate.

- [ ] **Step 4: Remove the seed rows**

```bash
docker exec claude-mem-postgres-1 psql -U admin -d claudemem -c "DELETE FROM teams WHERE name='demo';"
```
(Cascades to the demo project + observations.)

- [ ] **Step 5: Final commit / PR**

```bash
git add -A && git commit -m "chore: verified viewer renders on server-beta" --allow-empty
```
Then open a PR from `feat/server-beta-viewer-data-routes` (only when the user asks).

---

## Notes & Known Deviations

- **`id` type:** the viewer's TS type declares `id: number`; we pass the UUID string. Runtime-safe (React keys/display accept strings). Revisit only if a viewer feature breaks on a non-numeric id.
- **Non-implemented endpoints** the bundle may still call lazily (`/api/context/preview`, `/api/onboarding/explainer`, `/api/logs`) will 404. These are non-blocking for the feed; confirm in Step 3 that the main view renders. If any blocks rendering, add a stub in `ServerViewerDataRoutes` (out of current scope).
- **Auth:** routes are intentionally unauthenticated (read-only). Do not move them behind the api-key middleware.
- **No DB migration**; no viewer bundle change.
```
