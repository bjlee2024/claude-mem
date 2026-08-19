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
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    if (server?.getHttpServer()) { try { await server.close(); } catch { /* ignore */ } }
    try { await client.query(`DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`); } catch { /* ignore */ }
    client?.release?.();
    await pool.end();
    loggerSpies.forEach(s => s.mockRestore());
    loggerSpies = [];
  });

  it('returns {items, hasMore} with viewer-shaped, newest-first observations (no auth)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/observations?limit=2&offset=0`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: any[]; hasMore: boolean; offset: number; limit: number };
    expect(body.hasMore).toBe(true);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].content).toBeUndefined();
    expect(body.items[0].text).toBe('content 2');
    expect(body.items[0].project).toBe('proj-a');
    expect(body.items[0].facts).toBe('["f2"]');
    expect(typeof body.items[0].created_at_epoch).toBe('number');
  });

  it('paginates: offset past the end yields hasMore=false', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/observations?limit=2&offset=2`);
    const body = await res.json() as { items: any[]; hasMore: boolean };
    expect(body.items).toHaveLength(1);
    expect(body.hasMore).toBe(false);
  });

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

  it('GET /api/prompts returns an empty page when no user_prompt events exist', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/prompts`);
    const body = await res.json() as any;
    expect(body).toEqual({ items: [], hasMore: false, offset: 0, limit: 50 });
  });

  describe('GET /api/prompts with agent_events rows', () => {
    let sessionId: string;

    beforeEach(async () => {
      sessionId = crypto.randomUUID();
      await client.query(
        `INSERT INTO server_sessions (id, project_id, team_id, content_session_id, platform_source)
         VALUES ($1, $2, $3, 'content-sess-1', 'claude')`,
        [sessionId, projectId, teamId]
      );
      // Two prompt events attached to a known session, oldest first so
      // row_number() PARTITION BY server_session_id assigns 1 then 2.
      await client.query(
        `INSERT INTO agent_events
           (id, project_id, team_id, server_session_id, source_adapter, idempotency_key, event_type, payload, occurred_at)
         VALUES ($1, $2, $3, $4, 'test', $5, 'user_prompt', $6, now() - interval '2 minutes')`,
        [crypto.randomUUID(), projectId, teamId, sessionId, crypto.randomUUID(), JSON.stringify({ prompt: 'first prompt' })]
      );
      await client.query(
        `INSERT INTO agent_events
           (id, project_id, team_id, server_session_id, source_adapter, idempotency_key, event_type, payload, occurred_at)
         VALUES ($1, $2, $3, $4, 'test', $5, 'user_prompt', $6, now() - interval '1 minute')`,
        [crypto.randomUUID(), projectId, teamId, sessionId, crypto.randomUUID(), JSON.stringify({ prompt: 'second prompt' })]
      );
      // A prompt event with no server_session_id — must still come back via
      // the LEFT JOIN, with blank session fields rather than being dropped.
      await client.query(
        `INSERT INTO agent_events
           (id, project_id, team_id, server_session_id, source_adapter, idempotency_key, event_type, payload, occurred_at)
         VALUES ($1, $2, $3, NULL, 'test', $4, 'user_prompt', $5, now())`,
        [crypto.randomUUID(), projectId, teamId, crypto.randomUUID(), JSON.stringify({ prompt: 'orphan prompt' })]
      );
      // A non-prompt event that must be excluded by the event_type filter.
      await client.query(
        `INSERT INTO agent_events
           (id, project_id, team_id, server_session_id, source_adapter, idempotency_key, event_type, payload, occurred_at)
         VALUES ($1, $2, $3, $4, 'test', $5, 'tool_use', $6, now())`,
        [crypto.randomUUID(), projectId, teamId, sessionId, crypto.randomUUID(), JSON.stringify({ tool: 'Read' })]
      );
    });

    it('returns only user_prompt events, newest first, excluding tool_use rows', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/prompts?limit=10&offset=0`);
      expect(res.status).toBe(200);
      const body = await res.json() as { items: any[]; hasMore: boolean; offset: number; limit: number };
      expect(body.items).toHaveLength(3);
      expect(body.items.map((p: any) => p.prompt_text)).toEqual([
        'orphan prompt',
        'second prompt',
        'first prompt',
      ]);
      expect(body.hasMore).toBe(false);
    });

    it('returns a prompt with no server_session_id via LEFT JOIN, with blank session fields', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/prompts?limit=10&offset=0`);
      const body = await res.json() as { items: any[] };
      const orphan = body.items.find((p: any) => p.prompt_text === 'orphan prompt');
      expect(orphan).toBeTruthy();
      expect(orphan.content_session_id).toBe('');
      expect(orphan.platform_source).toBe('claude');
    });

    it('coerces prompt_number from Postgres bigint to a JS number', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/prompts?limit=10&offset=0`);
      const body = await res.json() as { items: any[] };
      for (const item of body.items) {
        expect(typeof item.prompt_number).toBe('number');
      }
      const first = body.items.find((p: any) => p.prompt_text === 'first prompt');
      const second = body.items.find((p: any) => p.prompt_text === 'second prompt');
      expect(first.prompt_number).toBe(1);
      expect(second.prompt_number).toBe(2);
    });

    it('carries content_session_id and platform_source from the joined session', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/prompts?limit=10&offset=0`);
      const body = await res.json() as { items: any[] };
      const first = body.items.find((p: any) => p.prompt_text === 'first prompt');
      expect(first.content_session_id).toBe('content-sess-1');
      expect(first.platform_source).toBe('claude');
      expect(first.project).toBe('proj-a');
    });
  });

  it('GET /api/prompts lists user_prompt events with grok platform_source', async () => {
    const sessionId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await client.query(
      `INSERT INTO server_sessions (id, project_id, team_id, external_session_id, content_session_id, platform_source)
       VALUES ($1, $2, $3, $4, $4, 'grok')`,
      [sessionId, projectId, teamId, 'grok-session-1'],
    );
    await client.query(
      `INSERT INTO agent_events (
         id, project_id, team_id, server_session_id, source_adapter, idempotency_key,
         event_type, platform_source, payload, occurred_at
       ) VALUES ($1, $2, $3, $4, 'hook', $5, 'user_prompt', 'grok', $6, now())`,
      [eventId, projectId, teamId, sessionId, `idem-${eventId}`, JSON.stringify({ prompt: 'list grok history' })],
    );

    const res = await fetch(`http://127.0.0.1:${port}/api/prompts`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].prompt_text).toBe('list grok history');
    expect(body.items[0].platform_source).toBe('grok');
    expect(body.items[0].project).toBe('proj-a');
  });

  it('GET /api/observations uses session platform_source, not generation provider', async () => {
    const sessionId = crypto.randomUUID();
    await client.query(
      `INSERT INTO server_sessions (id, project_id, team_id, platform_source)
       VALUES ($1, $2, $3, 'grok')`,
      [sessionId, projectId, teamId],
    );
    await client.query(
      `INSERT INTO observations (id, project_id, team_id, server_session_id, kind, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, 'observation', 'from grok', $5, now() + interval '10 seconds')`,
      [
        crypto.randomUUID(), projectId, teamId, sessionId,
        JSON.stringify({ title: 'Grok row', provider: 'openrouter' }),
      ],
    );

    const res = await fetch(`http://127.0.0.1:${port}/api/observations?limit=1&offset=0`);
    const body = await res.json() as { items: Array<{ platform_source: string; title: string }> };
    expect(body.items[0].title).toBe('Grok row');
    expect(body.items[0].platform_source).toBe('grok');
  });

  it('GET /api/projects includes grok in sources when a grok session exists', async () => {
    await client.query(
      `INSERT INTO server_sessions (id, project_id, team_id, platform_source)
       VALUES ($1, $2, $3, 'grok')`,
      [crypto.randomUUID(), projectId, teamId],
    );
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
    const body = await res.json() as { sources: string[]; projectsBySource: Record<string, string[]> };
    expect(body.sources).toContain('grok');
    expect(body.projectsBySource.grok).toEqual(['proj-a']);
  });

  it('GET /api/settings returns {} (viewer applies defaults)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});
