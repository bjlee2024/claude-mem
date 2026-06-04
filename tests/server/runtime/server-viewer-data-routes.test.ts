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
    expect(res.status).toBe(200);
    const body = await res.json() as { items: any[]; hasMore: boolean; offset: number; limit: number };
    expect(body.hasMore).toBe(true);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].content === undefined).toBe(true);
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
});
