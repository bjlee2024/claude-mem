# Client / Server Split Install — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make claude-mem installable as a thin **client** (stores memory to a remote server, no local DB) or a **server** (backend for remote + local clients), for a personal multi-device setup.

**Architecture:** Hooks call the remote server's `/v1/*` directly via the existing `ServerBetaClient` (approach A — daemonless). Per-repo projects resolve by name against the server. Offline writes spool to a local NDJSON file and flush on the next hook. Generation stays server-side, so clients need no provider key.

**Tech Stack:** TypeScript, Bun test runner, Express, node-postgres (`pg`). Server-beta mounts `src/server/routes/v1/ServerV1PostgresRoutes.ts`. Spec: `docs/superpowers/specs/2026-06-05-client-server-split-design.md`.

**Postgres-gated tests** run only when `CLAUDE_MEM_TEST_POSTGRES_URL` is set (convention from `tests/server/runtime/server-viewer-data-routes.test.ts`). Locally the Docker stack's Postgres is reachable at the container IP:
`export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://admin:medit@123@$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' claude-mem-postgres-1):5432/claudemem"`

---

## File Structure

**Create:**
- `src/server/storage/migrations/0002-projects-unique-name.ts` — migration adding `UNIQUE (team_id, name)` to `projects` (de-dupes first). *(Adjust path/format to match the existing migration mechanism discovered in Task 1.)*
- `src/services/hooks/project-resolver.ts` — resolve repo name → server project UUID, cached in `~/.claude-mem/project-map.json`.
- `src/services/hooks/spool.ts` — offline write spool (append, atomic take, FIFO replay).
- `src/services/hooks/enrollment.ts` — encode/decode the `base64url({url,key})` enrollment token.
- Test files mirroring each (see tasks).

**Modify:**
- `src/server/routes/v1/ServerV1PostgresRoutes.ts` — add `POST /v1/projects/resolve`; relax `/v1/context` to allow empty query (recent-mode).
- `src/services/hooks/runtime-selector.ts` — add `'client'` runtime; expose a client context without requiring a fixed `PROJECT_ID`.
- `src/cli/handlers/observation.ts`, `session-init.ts`, `context.ts`, `summarize.ts` — client branches + spool.
- `src/npx-cli/commands/install.ts` — `--mode server|client`.
- A new server CLI subcommand `server enroll` (wire into the existing `server` command dispatcher found in Task 9).

---

## Phase 1 — Server: project resolve + migration

### Task 1: Discover the migration mechanism

**Files:** (read-only investigation)

- [ ] **Step 1: Find how schema migrations are applied**

Run:
```bash
grep -rnE "bootstrapServerBetaPostgresSchema|CREATE TABLE IF NOT EXISTS|migration|ALTER TABLE" src/storage/postgres/ | head -30
sed -n '1,40p' src/storage/postgres/index.ts
```
Expected: identify the function that runs DDL on boot (e.g. `bootstrapServerBetaPostgresSchema`) and whether DDL is a single idempotent SQL string or discrete migration files.

- [ ] **Step 2: Record the integration point**

Write down (in the PR description later) the exact file + function where idempotent DDL runs. The migration in Task 2 will be appended there as an idempotent `ALTER`/`CREATE UNIQUE INDEX ... IF NOT EXISTS`, matching the existing style. No commit.

### Task 2: Add `UNIQUE (team_id, name)` to projects (idempotent)

**Files:**
- Modify: the bootstrap DDL location found in Task 1 (referred to below as `schema bootstrap`)
- Test: `tests/server/storage/projects-unique-name.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/server/storage/projects-unique-name.test.ts
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { bootstrapServerBetaPostgresSchema } from '../../../src/storage/postgres/index.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
function q(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

describe('projects UNIQUE (team_id, name)', () => {
  if (!testDatabaseUrl) { it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {}); return; }
  let pool: pg.Pool; let client: pg.PoolClient; let schema: string; let teamId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schema = `cm_uq_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schema)}`);
    await client.query(`SET search_path TO ${q(schema)}`);
    await bootstrapServerBetaPostgresSchema(client);
    teamId = crypto.randomUUID();
    await client.query("INSERT INTO teams (id, name) VALUES ($1, 'T')", [teamId]);
  });
  afterEach(async () => {
    try { await client.query(`DROP SCHEMA ${q(schema)} CASCADE`); } catch { /* ignore */ }
    client.release(); await pool.end();
  });

  it('rejects a duplicate (team_id, name)', async () => {
    await client.query('INSERT INTO projects (id, team_id, name) VALUES ($1,$2,$3)', [crypto.randomUUID(), teamId, 'dup']);
    let threw = false;
    try {
      await client.query('INSERT INTO projects (id, team_id, name) VALUES ($1,$2,$3)', [crypto.randomUUID(), teamId, 'dup']);
    } catch (e) { threw = true; expect(String(e)).toMatch(/unique|duplicate/i); }
    expect(threw).toBe(true);
  });

  it('allows the same name under a different team', async () => {
    const team2 = crypto.randomUUID();
    await client.query("INSERT INTO teams (id, name) VALUES ($1, 'T2')", [team2]);
    await client.query('INSERT INTO projects (id, team_id, name) VALUES ($1,$2,$3)', [crypto.randomUUID(), teamId, 'shared']);
    await client.query('INSERT INTO projects (id, team_id, name) VALUES ($1,$2,$3)', [crypto.randomUUID(), team2, 'shared']);
    const { rows } = await client.query("SELECT count(*)::int AS c FROM projects WHERE name = 'shared'");
    expect(rows[0].c).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/server/storage/projects-unique-name.test.ts`
Expected: FAIL — the duplicate insert currently SUCCEEDS (no unique constraint), so the first test's `threw` stays false.

- [ ] **Step 3: Add the idempotent unique index in the schema bootstrap**

Append to the bootstrap DDL (after the `projects` table creation), matching existing idempotent style:

```sql
-- Client/server split: per-repo project resolution requires names to be unique
-- within a team so POST /v1/projects/resolve can upsert by (team_id, name).
CREATE UNIQUE INDEX IF NOT EXISTS projects_team_name_uniq ON projects (team_id, name);
```

> If a deployed DB already has duplicate (team_id, name) rows, this index creation fails. Guard for production by first collapsing duplicates. For THIS host (9 projects, no known dupes) the index applies cleanly. Add a comment noting the de-dupe requirement for shared servers.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/server/storage/projects-unique-name.test.ts`
Expected: PASS (or SKIP without Postgres URL).

- [ ] **Step 5: Commit**

```bash
git add tests/server/storage/projects-unique-name.test.ts src/storage/postgres/
git commit -m "feat(server): unique (team_id, name) index on projects"
```

### Task 3: `POST /v1/projects/resolve` (resolve-or-create by name)

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts`
- Test: `tests/server/runtime/projects-resolve-route.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/server/runtime/projects-resolve-route.test.ts
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { bootstrapServerBetaPostgresSchema } from '../../../src/storage/postgres/index.js';
import { logger } from '../../../src/utils/logger.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
function q(n: string) { return `"${n.replaceAll('"', '""')}"`; }

describe('POST /v1/projects/resolve', () => {
  if (!testDatabaseUrl) { it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {}); return; }
  let pool: pg.Pool, client: pg.PoolClient, schema: string, server: Server, port: number;
  let teamId: string, apiKey: string, spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    spies = [spyOn(logger, 'info').mockImplementation(() => {}), spyOn(logger, 'error').mockImplementation(() => {}),
             spyOn(logger, 'warn').mockImplementation(() => {}), spyOn(logger, 'debug').mockImplementation(() => {})];
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schema = `cm_resolve_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schema)}`);
    await client.query(`SET search_path TO ${q(schema)}`);
    await bootstrapServerBetaPostgresSchema(client);

    teamId = crypto.randomUUID();
    await client.query("INSERT INTO teams (id, name) VALUES ($1, 'T')", [teamId]);
    // Team-scoped key (project_id NULL) with write scope. Insert directly using
    // the same key-hash scheme the auth middleware verifies — see Task 9 for the
    // helper; here we reuse the server's own key creation utility.
    apiKey = await createTeamScopedKey(client, teamId); // helper extracted in Task 15

    server = new Server({
      getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: () => Promise.resolve(), onRestart: () => Promise.resolve(),
      workerPath: '', getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({ getPool: () => client, /* match existing options */ } as any));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    port = (server.getHttpServer()!.address() as any).port;
  });
  afterEach(async () => {
    try { await server.close(); } catch { /* ignore */ }
    try { await client.query(`DROP SCHEMA ${q(schema)} CASCADE`); } catch { /* ignore */ }
    client.release(); await pool.end(); spies.forEach(s => s.mockRestore());
  });

  function authedPost(path: string, body: unknown) {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  }

  it('creates then returns the same id for the same name (idempotent)', async () => {
    const r1 = await authedPost('/v1/projects/resolve', { name: 'repo-a' });
    expect(r1.status).toBe(200);
    const id1 = (await r1.json() as any).id;
    expect(typeof id1).toBe('string');
    const r2 = await authedPost('/v1/projects/resolve', { name: 'repo-a' });
    const id2 = (await r2.json() as any).id;
    expect(id2).toBe(id1);
  });

  it('rejects an empty name with 400', async () => {
    const r = await authedPost('/v1/projects/resolve', { name: '' });
    expect(r.status).toBe(400);
  });
});
```

> The exact `ServerV1PostgresRoutes` constructor options and the `Server` option object must match what `ServerBetaService.ts:180` and `tests/server/runtime/server-viewer-data-routes.test.ts` already use. Copy those shapes verbatim when implementing — do not invent fields.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/server/runtime/projects-resolve-route.test.ts`
Expected: FAIL — route returns 404 (not implemented).

- [ ] **Step 3: Implement the route**

In `ServerV1PostgresRoutes.ts`, inside `setupRoutes` near the other `/v1/projects*` and `/v1/context` registrations, add:

```ts
// Client/server split — resolve-or-create a project by name within the
// caller's team. Enables per-repo auto-projects for thin clients. Requires a
// team-scoped key (project_id NULL); a project-scoped key can only see its own
// project, so cross-repo resolve is correctly forbidden by ensureProjectAllowed
// downstream when the resolved id differs.
app.post('/v1/projects/resolve', writeAuth, this.handleCreate(
  z.object({ name: z.string().min(1).max(200) }),
  async (req, res, body) => {
    const teamId = this.requireTeamId(req, res);
    if (!teamId) return;
    try {
      const result = await this.options.getPool().query<{ id: string }>(
        `INSERT INTO projects (id, team_id, name)
         VALUES (gen_random_uuid(), $1, $2)
         ON CONFLICT (team_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [teamId, body.name],
      );
      const id = result.rows[0]?.id;
      this.audit(req, 'project.resolve', id ?? null, id ?? null);
      res.json({ id });
    } catch (error) {
      this.handleDbError(error, res, 'project.resolve');
    }
  },
));
```

> Match the real DB-access accessor: confirm whether queries use `this.options.getPool()` or `this.options.getDatabase()` in this file (grep both) and use the one already present. `handleCreate`, `requireTeamId`, `audit`, `handleDbError`, and `writeAuth` already exist in this file.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/server/runtime/projects-resolve-route.test.ts`
Expected: PASS (after Task 9's `createTeamScopedKey` helper exists; if implementing Task 3 first, inline a minimal key insert and replace it in Task 9).

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/runtime/projects-resolve-route.test.ts
git commit -m "feat(server): POST /v1/projects/resolve resolve-or-create by name"
```

### Task 4: Relax `/v1/context` to allow empty query (recent-mode)

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (the `/v1/context` handler ~line 874)
- Test: `tests/server/runtime/context-recent-mode.test.ts`

- [ ] **Step 1: Read the current `/v1/context` handler**

Run: `sed -n '860,900p' src/server/routes/v1/ServerV1PostgresRoutes.ts`
Expected: a Zod schema requiring `query: z.string().min(1)` and a `MemoryItemsRepository(...).search(projectId, query, limit)` call. Note the exact repository call.

- [ ] **Step 2: Write the failing test**

```ts
// tests/server/runtime/context-recent-mode.test.ts
// SPDX-License-Identifier: Apache-2.0
// Mirror the setup of projects-resolve-route.test.ts (schema, team, team-scoped key,
// ServerV1PostgresRoutes mount). Seed 2 summary/observation rows for a project, then:
import { describe, it, expect } from 'bun:test';
// ... shared harness ...
it('returns recent observations when query is empty (session-start mode)', async () => {
  // seed project "p" with two memory rows (narrative "old", "new")
  const r = await authedPost('/v1/context', { projectId, query: '' , limit: 10 });
  expect(r.status).toBe(200);
  const body = await r.json() as { context: string; memories: unknown[] };
  expect(body.memories.length).toBeGreaterThanOrEqual(1);
  expect(body.context.length).toBeGreaterThan(0);
});
```

> Reuse the harness from Task 3 (extract a shared `tests/server/runtime/_v1-harness.ts` helper exporting `startV1Server()` returning `{port, authedPost, client, teamId, projectId, close}`; both tests import it). Seed rows via the repository or direct INSERT into the memory table discovered in Step 1.

- [ ] **Step 3: Run to verify it fails**

Run: `bun test tests/server/runtime/context-recent-mode.test.ts`
Expected: FAIL — current schema 400s on empty `query`.

- [ ] **Step 4: Implement recent-mode**

Change the `/v1/context` Zod schema to `query: z.string().optional()` and branch the handler:

```ts
// Client/server split — session-start context injection has no search query.
// When query is empty/absent, return the most recent observations for the
// project instead of an FTS match, so thin clients get a memory pack on start.
const limit = body.limit ?? 10;
const repo = new MemoryItemsRepository(this.options.getDatabase());
const memories = (body.query && body.query.trim().length > 0)
  ? repo.search(body.projectId, body.query, limit)
  : repo.listRecent(body.projectId, limit); // add listRecent if absent (see note)
```

> If `MemoryItemsRepository` has no `listRecent`, add one: `SELECT ... WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2` returning the same row shape as `search`. Keep the response shape identical: `{ memories, context: memories.map(m => m.narrative ?? m.text ?? m.title).filter(Boolean).join('\n\n') }`.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/server/runtime/context-recent-mode.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/runtime/context-recent-mode.test.ts tests/server/runtime/_v1-harness.ts
git commit -m "feat(server): /v1/context recent-mode when query is empty"
```

---

## Phase 2 — Client runtime: project resolver + context branch

### Task 5: `project-resolver.ts` (name → UUID with local cache)

**Files:**
- Create: `src/services/hooks/project-resolver.ts`
- Test: `tests/services/hooks/project-resolver.test.ts`

- [ ] **Step 1: Write the failing unit test (no DB, client mocked)**

```ts
// tests/services/hooks/project-resolver.test.ts
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectResolver } from '../../../src/services/hooks/project-resolver.js';

describe('ProjectResolver', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cm-resolver-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('resolves via client on miss, then serves from cache without a 2nd call', async () => {
    let calls = 0;
    const client = { resolveProject: async (_name: string) => { calls++; return 'uuid-1'; } };
    const r = new ProjectResolver({ client: client as any, mapPath: join(dir, 'project-map.json') });
    expect(await r.resolve('/home/u/repo-a')).toBe('uuid-1'); // basename -> repo-a
    expect(await r.resolve('/home/u/repo-a')).toBe('uuid-1');
    expect(calls).toBe(1);
  });

  it('uses basename of cwd as the project name', async () => {
    const seen: string[] = [];
    const client = { resolveProject: async (name: string) => { seen.push(name); return 'x'; } };
    const r = new ProjectResolver({ client: client as any, mapPath: join(dir, 'm.json') });
    await r.resolve('/a/b/my-repo');
    expect(seen).toEqual(['my-repo']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/services/hooks/project-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ProjectResolver`**

```ts
// src/services/hooks/project-resolver.ts
// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — resolves a repo working directory to a server project
// UUID, preserving worker-mode's per-repo isolation. Caches name→uuid in
// ~/.claude-mem/project-map.json so each repo hits the server's
// POST /v1/projects/resolve at most once per machine.
import { basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ProjectResolveClient {
  resolveProject(name: string): Promise<string>;
}

export interface ProjectResolverOptions {
  client: ProjectResolveClient;
  mapPath: string;
}

export class ProjectResolver {
  private readonly client: ProjectResolveClient;
  private readonly mapPath: string;
  private cache: Record<string, string>;

  constructor(opts: ProjectResolverOptions) {
    this.client = opts.client;
    this.mapPath = opts.mapPath;
    this.cache = this.load();
  }

  static projectName(cwd: string): string {
    return basename(cwd);
  }

  async resolve(cwd: string): Promise<string> {
    const name = ProjectResolver.projectName(cwd);
    const cached = this.cache[name];
    if (cached) return cached;
    const id = await this.client.resolveProject(name);
    this.cache[name] = id;
    this.persist();
    return id;
  }

  private load(): Record<string, string> {
    try {
      if (!existsSync(this.mapPath)) return {};
      return JSON.parse(readFileSync(this.mapPath, 'utf8')) as Record<string, string>;
    } catch { return {}; }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.mapPath), { recursive: true });
      writeFileSync(this.mapPath, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
    } catch { /* best-effort cache; resolution still works without persistence */ }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/services/hooks/project-resolver.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/hooks/project-resolver.ts tests/services/hooks/project-resolver.test.ts
git commit -m "feat(hooks): ProjectResolver name->uuid with local cache"
```

### Task 6: Add `resolveProject` to `ServerBetaClient`

**Files:**
- Modify: `src/services/hooks/server-beta-client.ts`
- Test: `tests/services/hooks/server-beta-client-resolve.test.ts`

- [ ] **Step 1: Write the failing test (mock fetch)**

```ts
// tests/services/hooks/server-beta-client-resolve.test.ts
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'bun:test';
import { ServerBetaClient } from '../../../src/services/hooks/server-beta-client.js';

describe('ServerBetaClient.resolveProject', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('POSTs /v1/projects/resolve and returns the id', async () => {
    let captured: { url: string; body: any } | null = null;
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ id: 'p-uuid' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as any;
    const c = new ServerBetaClient({ serverBaseUrl: 'http://h:1', apiKey: 'k' });
    const id = await c.resolveProject('repo-a');
    expect(id).toBe('p-uuid');
    expect(captured!.url).toContain('/v1/projects/resolve');
    expect(captured!.body).toEqual({ name: 'repo-a' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/services/hooks/server-beta-client-resolve.test.ts`
Expected: FAIL — `resolveProject` is not a function.

- [ ] **Step 3: Add the method**

In `server-beta-client.ts`, alongside `contextObservations`:

```ts
export interface ServerBetaResolveProjectResponse { id: string }

// Client/server split — resolve-or-create a project by repo name.
async resolveProject(name: string): Promise<string> {
  const res = await this.request<ServerBetaResolveProjectResponse>(
    'POST', '/v1/projects/resolve', { name },
  );
  return res.id;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/services/hooks/server-beta-client-resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/hooks/server-beta-client.ts tests/services/hooks/server-beta-client-resolve.test.ts
git commit -m "feat(hooks): ServerBetaClient.resolveProject"
```

### Task 7: `'client'` runtime in the selector

**Files:**
- Modify: `src/services/hooks/runtime-selector.ts`
- Test: `tests/services/hooks/runtime-selector-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/hooks/runtime-selector-client.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { normalizeRuntimeValue } from '../../../src/services/hooks/runtime-selector.js';

describe('runtime selector — client alias', () => {
  it('treats "client" as a server-beta-style remote runtime', () => {
    expect(normalizeRuntimeValue('client')).toBe('client');
    expect(normalizeRuntimeValue('server-beta')).toBe('server-beta');
    expect(normalizeRuntimeValue('worker')).toBe('worker');
    expect(normalizeRuntimeValue(undefined)).toBe('worker');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/services/hooks/runtime-selector-client.test.ts`
Expected: FAIL — `normalizeRuntimeValue` not exported.

- [ ] **Step 3: Implement**

In `runtime-selector.ts`:
- Add `export type SelectedRuntime = 'worker' | 'server-beta' | 'client';`
- Extract and export:

```ts
export function normalizeRuntimeValue(raw: string | undefined): SelectedRuntime {
  const v = (raw ?? 'worker').trim().toLowerCase();
  if (v === 'server-beta') return 'server-beta';
  if (v === 'client') return 'client';
  return 'worker';
}
```
- Rewrite `selectRuntime()` to `return normalizeRuntimeValue(loadFromFileOnce().CLAUDE_MEM_RUNTIME);`
- In `buildServerBetaContext()`, make `projectId` optional: drop the `if (!projectId)` early-return; keep `projectId: projectId || null` on the returned context. Update the interface:

```ts
export interface ServerBetaRuntimeContext {
  runtime: 'server-beta' | 'client';
  client: ServerBetaClient;
  projectId: string | null; // null => resolve per-repo
  serverBaseUrl: string;
}
```
- In `resolveRuntimeContext()`: treat both `'server-beta'` and `'client'` as remote. For `'client'`, set the returned `runtime` to `'client'`.

> Existing call sites check `runtime.runtime === 'server-beta'`. Update them to `runtime.runtime !== 'worker'` (Tasks 8, 11–13) so both remote runtimes share the branch.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/services/hooks/runtime-selector-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/hooks/runtime-selector.ts tests/services/hooks/runtime-selector-client.test.ts
git commit -m "feat(hooks): client runtime alias + optional fixed project id"
```

---

## Phase 3 — Offline spool + sync

### Task 8: `spool.ts` (append / atomic take / FIFO replay)

**Files:**
- Create: `src/services/hooks/spool.ts`
- Test: `tests/services/hooks/spool.test.ts`

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/services/hooks/spool.test.ts
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Spool } from '../../../src/services/hooks/spool.js';

describe('Spool', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cm-spool-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function newSpool() { return new Spool({ path: join(dir, 'pending.ndjson'), maxRecords: 5 }); }
  const rec = (id: string) => ({ id, kind: 'event' as const, endpoint: '/v1/events', body: { x: id }, projectName: 'p', enqueuedAtEpoch: 1 });

  it('append then flush replays FIFO and drops on success', async () => {
    const s = newSpool();
    s.append(rec('a')); s.append(rec('b'));
    const sent: string[] = [];
    await s.flush(async (r) => { sent.push(r.id); return { ok: true }; });
    expect(sent).toEqual(['a', 'b']);
    expect(s.depth()).toBe(0);
  });

  it('re-appends eligible failures, drops permanent (4xx)', async () => {
    const s = newSpool();
    s.append(rec('a')); s.append(rec('b'));
    await s.flush(async (r) => r.id === 'a' ? { ok: false, permanent: false } : { ok: false, permanent: true });
    expect(s.depth()).toBe(1); // 'a' re-queued, 'b' dropped
  });

  it('trims oldest beyond maxRecords', () => {
    const s = newSpool();
    for (const id of ['a','b','c','d','e','f','g']) s.append(rec(id));
    expect(s.depth()).toBe(5);
    expect(s.peekIds()).toEqual(['c','d','e','f','g']);
  });

  it('flush on empty spool is a no-op and does not create the file', async () => {
    const s = newSpool();
    await s.flush(async () => ({ ok: true }));
    expect(existsSync(join(dir, 'pending.ndjson'))).toBe(false);
    expect(s.depth()).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/services/hooks/spool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `Spool`**

```ts
// src/services/hooks/spool.ts
// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — durable offline write queue for thin clients. Hooks
// append failed remote writes here; the next hook invocation flushes them.
// Append-only NDJSON keeps concurrent hooks safe without locking; flush takes
// the file atomically (rename) so two flushers never double-send.
import {
  existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface SpoolRecord {
  id: string;
  kind: 'event' | 'session_start' | 'session_end';
  endpoint: string;
  body: unknown;
  projectName: string;
  enqueuedAtEpoch: number;
  attempts?: number;
}

export interface SpoolSendResult { ok: boolean; permanent?: boolean }
export type SpoolSender = (record: SpoolRecord) => Promise<SpoolSendResult>;

export interface SpoolOptions { path: string; maxRecords?: number }

export class Spool {
  private readonly path: string;
  private readonly maxRecords: number;

  constructor(opts: SpoolOptions) {
    this.path = opts.path;
    this.maxRecords = opts.maxRecords ?? 5000;
  }

  append(record: SpoolRecord): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(record) + '\n', { mode: 0o600 });
      this.trim();
    } catch { /* best-effort; never throw into a hook */ }
  }

  depth(): number { return this.read(this.path).length; }
  peekIds(): string[] { return this.read(this.path).map(r => r.id); }

  async flush(send: SpoolSender, budget = 200): Promise<void> {
    if (!existsSync(this.path)) return;
    const taking = `${this.path}.flushing.${process.pid}`;
    try { renameSync(this.path, taking); } catch { return; } // someone else took it
    const records = this.read(taking);
    const requeue: SpoolRecord[] = [];
    let processed = 0;
    for (const r of records) {
      if (processed >= budget) { requeue.push(r); continue; }
      processed++;
      try {
        const res = await send(r);
        if (!res.ok && !res.permanent) requeue.push({ ...r, attempts: (r.attempts ?? 0) + 1 });
        // ok or permanent => drop
      } catch { requeue.push({ ...r, attempts: (r.attempts ?? 0) + 1 }); }
    }
    try { unlinkSync(taking); } catch { /* ignore */ }
    for (const r of requeue) this.append(r);
  }

  private read(path: string): SpoolRecord[] {
    try {
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l) as SpoolRecord; } catch { return null; } })
        .filter((r): r is SpoolRecord => r !== null);
    } catch { return []; }
  }

  private trim(): void {
    const all = this.read(this.path);
    if (all.length <= this.maxRecords) return;
    const kept = all.slice(all.length - this.maxRecords);
    try { writeFileSync(this.path, kept.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/services/hooks/spool.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/hooks/spool.ts tests/services/hooks/spool.test.ts
git commit -m "feat(hooks): offline write spool (append/take/replay/trim)"
```

### Task 9: Shared client-write helper (resolve + send + spool)

**Files:**
- Create: `src/services/hooks/client-write.ts`
- Test: `tests/services/hooks/client-write.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/hooks/client-write.test.ts
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientWriter } from '../../../src/services/hooks/client-write.js';
import { Spool } from '../../../src/services/hooks/spool.js';
import { ServerBetaClientError } from '../../../src/services/hooks/server-beta-client.js';

describe('ClientWriter', () => {
  let dir: string; let spool: Spool;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cm-cw-')); spool = new Spool({ path: join(dir, 's.ndjson') }); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const resolver = { resolve: async (_cwd: string) => 'pid-1' } as any;

  it('on eligible failure, spools the write and never throws', async () => {
    const client = {
      recordEvent: async () => { throw new ServerBetaClientError('timeout', 'slow'); },
    } as any;
    const w = new ClientWriter({ client, resolver, spool });
    await w.recordToolUse({ cwd: '/x/repo', sessionId: 's', sourceEventId: 'e1', payload: {} });
    expect(spool.depth()).toBe(1);
    expect(spool.peekIds()).toEqual(['e1']);
  });

  it('on success, does not spool', async () => {
    const client = { recordEvent: async () => ({ event: { id: 'x' } }) } as any;
    const w = new ClientWriter({ client, resolver, spool });
    await w.recordToolUse({ cwd: '/x/repo', sessionId: 's', sourceEventId: 'e1', payload: {} });
    expect(spool.depth()).toBe(0);
  });
});
```

> Confirm `ServerBetaClientError`'s constructor signature (`new ServerBetaClientError(kind, message)`) and that `kind: 'timeout'` is fallback-eligible per `isFallbackEligible()`; adjust the test's thrown error to a known eligible kind.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/services/hooks/client-write.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ClientWriter`**

```ts
// src/services/hooks/client-write.ts
// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — single funnel for thin-client writes. Resolves the
// per-repo project, sends to the server, and spools on eligible failure. The
// spool record's id is reused as the event sourceEventId so server-side
// idempotency (agent_events.idempotency_key) absorbs replays. NEVER throws into
// a hook.
import type { ServerBetaClient } from './server-beta-client.js';
import { isServerBetaClientError } from './server-beta-client.js';
import type { ProjectResolver } from './project-resolver.js';
import type { Spool, SpoolRecord } from './spool.js';
import { logger } from '../../utils/logger.js';

export interface ClientWriterOptions {
  client: ServerBetaClient;
  resolver: ProjectResolver;
  spool: Spool;
  fixedProjectId?: string | null;
}

export interface RecordToolUseInput {
  cwd: string;
  sessionId: string;
  sourceEventId: string;
  payload: unknown;
}

export class ClientWriter {
  constructor(private readonly o: ClientWriterOptions) {}

  private async projectId(cwd: string): Promise<string> {
    return this.o.fixedProjectId ?? this.o.resolver.resolve(cwd);
  }

  async recordToolUse(input: RecordToolUseInput): Promise<void> {
    let projectId: string;
    try { projectId = await this.projectId(input.cwd); }
    catch (e) { this.spoolByName(input, 'tool_use'); return; } // can't resolve (offline) -> spool by name

    try {
      await this.o.client.recordEvent({
        projectId,
        contentSessionId: input.sessionId,
        sourceType: 'hook',
        eventType: 'tool_use',
        occurredAtEpoch: Date.now(),
        sourceEventId: input.sourceEventId,
        payload: input.payload,
      } as Parameters<ServerBetaClient['recordEvent']>[0]);
    } catch (error) {
      if (isServerBetaClientError(error) && error.isFallbackEligible()) {
        this.spoolByName(input, 'tool_use');
      } else {
        logger.error('HOOK', 'client write permanent failure', { error: String(error) });
      }
    }
  }

  private spoolByName(input: RecordToolUseInput, eventType: string): void {
    const record: SpoolRecord = {
      id: input.sourceEventId,
      kind: 'event',
      endpoint: '/v1/events',
      body: {
        contentSessionId: input.sessionId,
        sourceType: 'hook',
        eventType,
        occurredAtEpoch: Date.now(),
        sourceEventId: input.sourceEventId,
        payload: input.payload,
      },
      projectName: ProjectResolverName(input.cwd),
      enqueuedAtEpoch: Date.now(),
    };
    this.o.spool.append(record);
  }
}

// Local import to avoid a cycle: name derivation lives on the resolver class.
import { ProjectResolver } from './project-resolver.js';
function ProjectResolverName(cwd: string): string { return ProjectResolver.projectName(cwd); }
```

> `recordEvent`'s request type does not currently include `sourceEventId` in `ServerBetaRecordEventRequest`. Add `sourceEventId?: string | null;` to that interface and ensure the client forwards it in the request body (it already spreads the request — confirm `buildRecordEventPayload`/`recordEvent` passes it through; add it if not). The server already reads `body.sourceEventId` (`ServerV1PostgresRoutes.ts:984`).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/services/hooks/client-write.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/hooks/client-write.ts src/services/hooks/server-beta-client.ts tests/services/hooks/client-write.test.ts
git commit -m "feat(hooks): ClientWriter funnel with spool-on-failure"
```

### Task 10: Spool flush sender + a flush entrypoint

**Files:**
- Create: `src/services/hooks/spool-flush.ts` (builds a `SpoolSender` from a `ServerBetaClient` + `ProjectResolver`, classifies errors)
- Test: `tests/services/hooks/spool-flush.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/hooks/spool-flush.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { makeSpoolSender } from '../../../src/services/hooks/spool-flush.js';
import { ServerBetaClientError } from '../../../src/services/hooks/server-beta-client.js';

describe('makeSpoolSender', () => {
  const baseRecord = { id: 'e1', kind: 'event' as const, endpoint: '/v1/events', body: { eventType: 'tool_use', payload: {} }, projectName: 'p', enqueuedAtEpoch: 1 };

  it('resolves projectName then posts; ok on success', async () => {
    const client = { resolveProject: async () => 'pid', recordEvent: async () => ({ event: { id: 'x' } }) } as any;
    const send = makeSpoolSender({ client });
    expect(await send(baseRecord)).toEqual({ ok: true });
  });

  it('classifies eligible error as retryable (ok:false, permanent:false)', async () => {
    const client = { resolveProject: async () => 'pid', recordEvent: async () => { throw new ServerBetaClientError('timeout', 't'); } } as any;
    const send = makeSpoolSender({ client });
    expect(await send(baseRecord)).toEqual({ ok: false, permanent: false });
  });

  it('classifies 4xx as permanent', async () => {
    const err = new ServerBetaClientError('http_error', 'bad'); (err as any).status = 400;
    const client = { resolveProject: async () => 'pid', recordEvent: async () => { throw err; } } as any;
    const send = makeSpoolSender({ client });
    expect(await send(baseRecord)).toEqual({ ok: false, permanent: true });
  });
});
```

> Confirm the `ServerBetaClientError` kind/`status` fields and which kinds `isFallbackEligible()` returns true for; align the test's error construction with the real type.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/services/hooks/spool-flush.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `makeSpoolSender`**

```ts
// src/services/hooks/spool-flush.ts
// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — turns a spooled record back into a server write.
// projectName is resolved at flush time (the UUID may not have existed when the
// record was enqueued offline). Errors are classified: eligible -> retry,
// everything else (incl. 4xx) -> permanent drop.
import type { ServerBetaClient } from './server-beta-client.js';
import { isServerBetaClientError } from './server-beta-client.js';
import type { SpoolRecord, SpoolSendResult } from './spool.js';

export interface SpoolSenderDeps { client: ServerBetaClient }

export function makeSpoolSender(deps: SpoolSenderDeps): (r: SpoolRecord) => Promise<SpoolSendResult> {
  return async (r: SpoolRecord): Promise<SpoolSendResult> => {
    try {
      const projectId = await deps.client.resolveProject(r.projectName);
      const body = r.body as Record<string, unknown>;
      await deps.client.recordEvent({
        projectId,
        contentSessionId: (body.contentSessionId as string | undefined) ?? null,
        sourceType: 'hook',
        eventType: (body.eventType as string) ?? 'tool_use',
        occurredAtEpoch: (body.occurredAtEpoch as number) ?? Date.now(),
        sourceEventId: (body.sourceEventId as string) ?? r.id,
        payload: body.payload,
      } as Parameters<ServerBetaClient['recordEvent']>[0]);
      return { ok: true };
    } catch (error) {
      if (isServerBetaClientError(error) && error.isFallbackEligible()) return { ok: false, permanent: false };
      return { ok: false, permanent: true };
    }
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/services/hooks/spool-flush.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/hooks/spool-flush.ts tests/services/hooks/spool-flush.test.ts
git commit -m "feat(hooks): spool flush sender with error classification"
```

---

## Phase 4 — Wire client branches into hook handlers

**Shared setup for Tasks 11–13** — add `buildClientContext()` to
`runtime-selector.ts`. It assembles the per-hook client wiring from a remote
runtime context and the `~/.claude-mem` data dir. Implement and unit-test it as
**Task 10b** (between Tasks 10 and 11):

```ts
// in src/services/hooks/runtime-selector.ts
import { DATA_DIR } from '../../shared/paths.js';          // confirm exact export name in paths.ts
import { join } from 'node:path';
import { ProjectResolver } from './project-resolver.js';
import { Spool } from './spool.js';
import { ClientWriter } from './client-write.js';

export interface ClientContext {
  client: ServerBetaClient;
  resolver: ProjectResolver;
  spool: Spool;
  writer: ClientWriter;
  fixedProjectId: string | null;
}

export function buildClientContext(ctx: ServerBetaRuntimeContext): ClientContext {
  const resolver = new ProjectResolver({ client: ctx.client, mapPath: join(DATA_DIR, 'project-map.json') });
  const spool = new Spool({ path: join(DATA_DIR, 'spool', 'pending.ndjson') });
  const writer = new ClientWriter({ client: ctx.client, resolver, spool, fixedProjectId: ctx.projectId });
  return { client: ctx.client, resolver, spool, writer, fixedProjectId: ctx.projectId };
}
```

Test (`tests/services/hooks/build-client-context.test.ts`): construct from a stub
`ServerBetaRuntimeContext` and assert the returned object has a `writer`, `spool`,
and `resolver`, and that `fixedProjectId` mirrors the input `projectId`. Commit:
`feat(hooks): buildClientContext wiring helper`.

Each handler (Tasks 11–13) calls `await spool.flush(makeSpoolSender({ client }))`
at entry to pump the backlog before doing its own work.

### Task 11: `observation.ts` — client branch + spool flush

**Files:**
- Modify: `src/cli/handlers/observation.ts`
- Test: `tests/cli/handlers/observation-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/handlers/observation-client.test.ts
// SPDX-License-Identifier: Apache-2.0
// Mock resolveRuntimeContext to return a 'client' context whose client.recordEvent
// throws an eligible error; assert the handler spools and returns continue:true,
// exitCode SUCCESS (never throws / never blocks).
import { describe, expect, it } from 'bun:test';
// ... mock module + temp spool dir ...
it('client mode: eligible failure spools and returns success', async () => {
  // arrange a client ctx with throwing recordEvent + temp spool
  const result = await observationHandler.execute(makeInput({ cwd: '/x/repo', toolName: 'Read' }));
  expect(result.continue).toBe(true);
  // assert spool depth == 1 via the injected spool path
});
```

> Use the project's existing handler-test pattern (search `tests/cli/handlers/` for how `resolveRuntimeContext` is mocked — likely `spyOn` on the module). Match it.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/cli/handlers/observation-client.test.ts`
Expected: FAIL — handler has no client branch (treats client ctx as worker).

- [ ] **Step 3: Implement**

Replace the `if (runtime.runtime === 'server-beta')` block with a remote branch covering both runtimes, routed through `ClientWriter` so spool-on-failure is uniform:

```ts
const runtime = resolveRuntimeContext();
if (runtime.runtime !== 'worker') {
  const { writer, spool, client } = buildClientContext(runtime);
  await spool.flush(makeSpoolSender({ client })); // pump backlog first
  await writer.recordToolUse({
    cwd, sessionId, sourceEventId: crypto.randomUUID(),
    payload: { tool_name: toolName, tool_input: toolInput, tool_response: toolResponse, cwd,
               agentId: input.agentId, agentType: input.agentType, platformSource },
  });
  return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
}
return dispatchToWorker(input, platformSource);
```

> `buildClientContext(runtime)` is the Phase-4 helper. It constructs `ProjectResolver` (mapPath `~/.claude-mem/project-map.json`), `Spool` (path `~/.claude-mem/spool/pending.ndjson`), `ClientWriter`, passing `fixedProjectId = runtime.projectId` (may be null). For `'server-beta'` with a non-null `projectId`, behavior is unchanged (single pool).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/cli/handlers/observation-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/handlers/observation.ts src/services/hooks/runtime-selector.ts tests/cli/handlers/observation-client.test.ts
git commit -m "feat(hooks): observation handler client branch + spool"
```

### Task 12: `context.ts` — client branch reads `/v1/context`

**Files:**
- Modify: `src/cli/handlers/context.ts`
- Test: `tests/cli/handlers/context-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/handlers/context-client.test.ts
// SPDX-License-Identifier: Apache-2.0
// Mock resolveRuntimeContext -> client ctx; client.contextObservations returns
// { memories:[], context:'remembered: X' }. Assert additionalContext === 'remembered: X'.
import { describe, expect, it } from 'bun:test';
it('client mode injects remote context string', async () => {
  const result = await contextHandler.execute(makeInput({ cwd: '/x/repo', platform: 'claude-code' }));
  expect(result.hookSpecificOutput?.additionalContext).toBe('remembered: X');
});
it('client mode offline returns empty context (never throws)', async () => {
  // client.contextObservations throws eligible error
  const result = await contextHandler.execute(makeInput({ cwd: '/x/repo' }));
  expect(result.hookSpecificOutput?.additionalContext).toBe('');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/cli/handlers/context-client.test.ts`
Expected: FAIL — handler always uses local worker.

- [ ] **Step 3: Implement**

At the top of `contextHandler.execute`, before the worker path:

```ts
const runtime = resolveRuntimeContext();
if (runtime.runtime !== 'worker') {
  const { client, resolver } = buildClientContext(runtime);
  const emptyResult: HookResult = {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
    exitCode: HOOK_EXIT_CODES.SUCCESS,
  };
  try {
    const projectId = runtime.projectId ?? await resolver.resolve(cwd);
    const ctx = await client.contextObservations({ projectId, query: '', limit: 10 });
    return {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: (ctx.context ?? '').trim() },
    };
  } catch {
    return emptyResult; // offline / error => no context, never block
  }
}
// ...existing worker path unchanged...
```

> Import `resolveRuntimeContext`, `buildClientContext`, and `crypto` as needed. Keep the stale-OAuth-marker logic for worker mode only (it's worker-specific).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/cli/handlers/context-client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/handlers/context.ts tests/cli/handlers/context-client.test.ts
git commit -m "feat(hooks): context handler reads remote /v1/context in client mode"
```

### Task 13: `session-init.ts` and `summarize.ts` — client branches + spool

**Files:**
- Modify: `src/cli/handlers/session-init.ts`, `src/cli/handlers/summarize.ts`
- Test: `tests/cli/handlers/session-lifecycle-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/handlers/session-lifecycle-client.test.ts
// SPDX-License-Identifier: Apache-2.0
// For each of session-init (startSession) and summarize (endSession):
//  - client ctx with throwing eligible method -> handler returns continue:true and spools.
import { describe, expect, it } from 'bun:test';
it('session-init client mode: eligible failure does not block', async () => {
  const result = await sessionInitHandler.execute(makeInput({ cwd: '/x/repo' }));
  expect(result.continue).toBe(true);
});
it('summarize client mode: eligible failure does not block', async () => {
  const result = await summarizeHandler.execute(makeInput({ cwd: '/x/repo' }));
  expect(result.continue).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/cli/handlers/session-lifecycle-client.test.ts`
Expected: FAIL — `'client'` ctx falls through to worker.

- [ ] **Step 3: Implement**

- `session-init.ts`: change `if (runtime.runtime === 'server-beta')` to `!== 'worker'`; resolve `projectId = runtime.projectId ?? await resolver.resolve(cwd)`; on eligible failure, spool a `session_start` record (best-effort) and return `continue:true`. Flush the spool at entry.
- `summarize.ts`: same pattern with `client.endSession({ sessionId })`; on eligible failure spool a `session_end` record; never block.

> Reuse `buildClientContext(runtime)`. The spool sender currently only replays `/v1/events`; for `session_start`/`session_end` records, extend `makeSpoolSender` to branch on `record.kind` and call `startSession`/`endSession`. Add that branch and a unit test mirroring Task 10.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/cli/handlers/session-lifecycle-client.test.ts tests/services/hooks/spool-flush.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/handlers/session-init.ts src/cli/handlers/summarize.ts src/services/hooks/spool-flush.js tests/cli/handlers/session-lifecycle-client.test.ts
git commit -m "feat(hooks): session lifecycle client branches + spool"
```

---

## Phase 5 — Install `--mode` + enrollment

### Task 14: Enrollment token encode/decode

**Files:**
- Create: `src/services/hooks/enrollment.ts`
- Test: `tests/services/hooks/enrollment.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/hooks/enrollment.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { encodeEnrollment, decodeEnrollment } from '../../../src/services/hooks/enrollment.js';

describe('enrollment token', () => {
  it('round-trips url + key', () => {
    const t = encodeEnrollment({ url: 'https://100.77.250.118:37700', key: 'cm_abc.def' });
    expect(decodeEnrollment(t)).toEqual({ url: 'https://100.77.250.118:37700', key: 'cm_abc.def' });
  });
  it('throws on malformed token', () => {
    expect(() => decodeEnrollment('not-base64url!!')).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/services/hooks/enrollment.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/services/hooks/enrollment.ts
// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — a one-line enrollment token bundling the server URL and
// a team-scoped API key, for `install --mode client --enroll <token>`.
export interface Enrollment { url: string; key: string }

export function encodeEnrollment(e: Enrollment): string {
  return Buffer.from(JSON.stringify({ url: e.url, key: e.key }), 'utf8').toString('base64url');
}

export function decodeEnrollment(token: string): Enrollment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch { throw new Error('Invalid enrollment token'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid enrollment token');
  const { url, key } = parsed as Record<string, unknown>;
  if (typeof url !== 'string' || typeof key !== 'string' || !url || !key) throw new Error('Invalid enrollment token');
  return { url, key };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/services/hooks/enrollment.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/hooks/enrollment.ts tests/services/hooks/enrollment.test.ts
git commit -m "feat(hooks): enrollment token encode/decode"
```

### Task 15: `server enroll` CLI (team-scoped key + token)

**Files:**
- Modify: the `server` CLI dispatcher (find it in Step 1)
- Test: `tests/server/enroll-key.test.ts`

- [ ] **Step 1: Find the server CLI + key-creation utility**

Run:
```bash
grep -rnE "api-key create|apiKeyCreate|createApiKey|'enroll'|server (api-key|keys)" src/ | grep -iv test | head -20
```
Expected: locate (a) the command dispatcher that handles `server <subcommand>` in `server-beta-service.cjs`/its TS source, and (b) the function that hashes+inserts an api key row. Record both. Extract a reusable `createTeamScopedKey(db, teamId, label?)` from the existing key-create path (used by both the route test in Task 3 and here).

- [ ] **Step 2: Write the failing integration test**

```ts
// tests/server/enroll-key.test.ts
// SPDX-License-Identifier: Apache-2.0
// Postgres-gated. Create a team, call the extracted createTeamScopedKey(),
// then verify: the row has project_id NULL and scopes include memories:read+write,
// and the returned plaintext key authenticates a GET /v1/info (200).
import { describe, it, expect } from 'bun:test';
it('creates a team-scoped read+write key that authenticates', async () => {
  // ... setup per _v1-harness ...
  const key = await createTeamScopedKey(client, teamId, 'laptop');
  const row = (await client.query('SELECT project_id, scopes FROM api_keys ORDER BY created_at DESC LIMIT 1')).rows[0];
  expect(row.project_id).toBeNull();
  // scopes contains memories:read and memories:write
  const res = await fetch(`http://127.0.0.1:${port}/v1/info`, { headers: { authorization: `Bearer ${key}` } });
  expect([200, 401]).toContain(res.status); // /v1/info may be unauthenticated; assert key works on a scoped GET instead
});
```

> If `/v1/info` is unauthenticated, assert against a `memories:read` route (e.g. `/v1/projects/resolve` write, or a read route) to prove the key + scopes work.

- [ ] **Step 3: Run to verify it fails**

Run: `bun test tests/server/enroll-key.test.ts`
Expected: FAIL — `createTeamScopedKey` not exported yet.

- [ ] **Step 4: Implement `createTeamScopedKey` + `server enroll`**

- Export `createTeamScopedKey(db, teamId, label?)` from the key utility module (reusing the existing hash+insert; set `project_id = NULL`, `scopes = ['memories:read','memories:write']`). Return the plaintext key.
- Add a `server enroll [--label <name>]` subcommand: ensure a default team exists (reuse install bootstrap), call `createTeamScopedKey`, read the server URL from config, print:
  ```
  Enroll a device with:
    npx claude-mem install --mode client --enroll <encodeEnrollment({url,key})>
  ```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/server/enroll-key.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ tests/server/enroll-key.test.ts
git commit -m "feat(server): server enroll — team-scoped key + enrollment token"
```

### Task 16: `install --mode server|client`

**Files:**
- Modify: `src/npx-cli/commands/install.ts`
- Test: `tests/npx-cli/install-mode.test.ts`

- [ ] **Step 1: Read the current install flow + flag parsing**

Run: `sed -n '660,780p' src/npx-cli/commands/install.ts`
Expected: see how `--runtime` is parsed and how settings are written. Note the functions for writing `~/.claude-mem/settings.json` and installing IDE hooks.

- [ ] **Step 2: Write the failing test**

```ts
// tests/npx-cli/install-mode.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { resolveInstallMode } from '../../src/npx-cli/commands/install.js';

describe('resolveInstallMode', () => {
  it('--mode client maps to runtime=client and requires server config', () => {
    const r = resolveInstallMode({ mode: 'client', enroll: encodeSample() });
    expect(r.runtime).toBe('client');
    expect(r.serverUrl).toContain('http');
    expect(r.apiKey.length).toBeGreaterThan(0);
  });
  it('--mode server maps to runtime=server-beta with provisioning', () => {
    const r = resolveInstallMode({ mode: 'server' });
    expect(r.runtime).toBe('server-beta');
    expect(r.provision).toBe(true);
  });
  it('no mode preserves legacy runtime selection', () => {
    const r = resolveInstallMode({ runtime: 'worker' });
    expect(r.runtime).toBe('worker');
  });
});
```

> `encodeSample()` builds a token via `encodeEnrollment({url:'http://h:1', key:'k'})`.

- [ ] **Step 3: Run to verify it fails**

Run: `bun test tests/npx-cli/install-mode.test.ts`
Expected: FAIL — `resolveInstallMode` not exported.

- [ ] **Step 4: Implement `resolveInstallMode` + wire it**

```ts
// in install.ts
import { decodeEnrollment } from '../../services/hooks/enrollment.js';

export interface InstallModeArgs {
  mode?: 'server' | 'client';
  runtime?: string;
  enroll?: string;
  serverUrl?: string;
  token?: string;
}
export interface ResolvedInstall {
  runtime: 'worker' | 'server-beta' | 'client';
  provision: boolean;
  serverUrl: string;
  apiKey: string;
  withLocalClient: boolean;
}

export function resolveInstallMode(args: InstallModeArgs): ResolvedInstall {
  if (args.mode === 'server') {
    return { runtime: 'server-beta', provision: true, serverUrl: '', apiKey: '', withLocalClient: true };
  }
  if (args.mode === 'client') {
    let url = args.serverUrl ?? ''; let key = args.token ?? '';
    if (args.enroll) { const e = decodeEnrollment(args.enroll); url = e.url; key = e.key; }
    if (!url || !key) throw new Error('client mode requires --enroll <token> or --server-url and --token');
    return { runtime: 'client', provision: false, serverUrl: url, apiKey: key, withLocalClient: false };
  }
  const runtime = (args.runtime as ResolvedInstall['runtime']) ?? 'worker';
  return { runtime, provision: runtime === 'server-beta', serverUrl: '', apiKey: '', withLocalClient: false };
}
```

Then in the install command body:
- Parse `--mode`, `--enroll`, `--server-url`, `--token`, `--with-local-client`.
- Call `resolveInstallMode`. Write settings: `CLAUDE_MEM_RUNTIME=<runtime>`, and for client also `CLAUDE_MEM_SERVER_BETA_URL`, `CLAUDE_MEM_SERVER_BETA_API_KEY` (0600 `.env`).
- **Client path:** install IDE hooks; **skip** worker/SQLite/Chroma setup and the provider-key prompt; run preflight `GET /v1/info` (warn-only on failure).
- **Server path:** run existing server-beta provisioning (Docker/systemd ensure + schema bootstrap + migration), then call `server enroll` once and print the token. Install IDE hooks only if `withLocalClient`.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/npx-cli/install-mode.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/npx-cli/commands/install.ts tests/npx-cli/install-mode.test.ts
git commit -m "feat(install): --mode server|client"
```

### Task 17: `client status` diagnostic (optional but small)

**Files:**
- Modify: the CLI dispatcher to add `client status`
- Test: `tests/cli/client-status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/client-status.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { buildClientStatus } from '../../src/cli/client-status.js';

it('reports runtime, reachability, and spool depth', async () => {
  const status = await buildClientStatus({
    runtime: 'client', serverBaseUrl: 'http://h:1',
    ping: async () => true, spoolDepth: () => 3,
  });
  expect(status).toEqual({ runtime: 'client', server: 'http://h:1', reachable: true, spoolDepth: 3 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/cli/client-status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `buildClientStatus`** (pure function assembling the object from injected probes), then wire a `client status` subcommand that prints it as JSON using a real ping (`GET /v1/info`) and `new Spool(...).depth()`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/cli/client-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/client-status.ts tests/cli/client-status.test.ts src/
git commit -m "feat(cli): client status diagnostic"
```

---

## Phase 6 — Build, deploy, E2E verification

### Task 18: Build, sync, restart server stack

- [ ] **Step 1: Build and sync**

Run:
```bash
npm run build-and-sync
docker compose -f docker-compose.my.yml build claude-mem-server claude-mem-worker
sudo systemctl restart claude-mem    # or: docker compose -f docker-compose.my.yml up -d
```
Expected: stack healthy (`systemctl status claude-mem`, all containers healthy).

- [ ] **Step 2: Apply migration on the live DB**

The unique index is created by schema bootstrap on boot. Verify:
```bash
docker exec claude-mem-postgres-1 psql -U admin -d claudemem -c "\d projects" | grep -i 'projects_team_name_uniq' && echo OK
```
Expected: index present (`OK`).

### Task 19: Provision + enroll

- [ ] **Step 1: Generate an enrollment token from the server**

Run (inside the server container or via the CLI):
```bash
docker exec claude-mem-claude-mem-server-1 sh -lc 'claude-mem server enroll --label laptop'
```
Expected: prints `npx claude-mem install --mode client --enroll <token>`.

### Task 20: E2E — client write/read + offline spool

- [ ] **Step 1: Configure a client (this host as loopback client, or a second device)**

Run on the client:
```bash
npx claude-mem install --mode client --enroll <token>
```
Expected: settings written; preflight `GET /v1/info` reports reachable.

- [ ] **Step 2: Online round-trip**

Trigger a Claude Code session in a repo; perform a tool use. Verify on the server:
```bash
curl -s "http://127.0.0.1:37700/api/observations?limit=5"   # viewer data route from prior work
```
Expected: the event/observation appears under a project named after the repo; a second repo yields a second project.

- [ ] **Step 3: Offline spool + sync**

Run:
```bash
sudo systemctl stop claude-mem            # server down
# perform tool uses in a Claude Code session -> hooks should NOT block
ls -l ~/.claude-mem/spool/pending.ndjson  # records accumulate
sudo systemctl start claude-mem           # server up
# trigger one more hook (any tool use) to pump the spool
curl -s "http://127.0.0.1:37700/api/stats"
```
Expected: while down, the session is never blocked and records spool; after restart, the next hook flushes the spool and `totalObservations` increases; `pending.ndjson` drains to empty.

- [ ] **Step 4: Context injection**

Start a fresh Claude Code session in the same repo. Expected: prior observations are injected as session-start context (served from the remote `/v1/context` recent-mode), confirming remote read works with no local DB.

### Task 21: Full suite + finish

- [ ] **Step 1: Run the full test suite (Postgres-gated)**

Run:
```bash
export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://admin:medit@123@$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' claude-mem-postgres-1):5432/claudemem"
bun test tests/
```
Expected: new suites PASS; pre-existing failures (see prior branch notes — `ServerBetaService` pool double-close etc.) remain unchanged. Diff against the documented baseline; no NEW failures from this branch.

- [ ] **Step 2: Commit any build-artifact changes**

```bash
git add plugin/ && git commit -m "build: sync plugin artifacts for client/server split" || echo "no artifact changes"
```

- [ ] **Step 3: Finish the branch**

Use superpowers:finishing-a-development-branch to merge / PR per your choice (push target is the fork `origin`).

---

## Notes & Known Deviations

- **Refines the spec:** `/v1/context` gains a recent-mode (empty query) because session-start has no search query — the spec assumed `/v1/context` directly but didn't specify the query. Method name is `contextObservations` (spec said `getContextObservations`).
- **Idempotency:** client supplies `sourceEventId` (= spool record id); the server derives `agent_events.idempotency_key` from it (`ServerV1PostgresRoutes.ts:984`), so spool replays dedupe. Confirm the repository actually builds the key from `sourceEventId`; if it instead always random-generates, add a deterministic fallback (`sourceAdapter:sourceEventId`).
- **Two v1 route files:** server-beta mounts `ServerV1PostgresRoutes.ts` only. Do NOT add the new routes to `ServerV1Routes.ts` (SQLite/worker) unless worker mode also needs them (it does not).
- **`server api-key list` bug** (`last_used_at` missing) is out of scope; `enroll` only creates.
- **file-context (PreToolUse Read)** stays a no-op in client mode for v1 (session-start `/v1/context` covers memory injection). Future: wire to `/v1/search` by file path.
- **Migration safety on shared servers:** `projects_team_name_uniq` fails if duplicate (team_id, name) rows exist. This host has none; for other deployments collapse duplicates first.
- **No DB destructive changes**; existing `worker`/`server-beta` installs keep working; `client` is additive.
