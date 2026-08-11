// SPDX-License-Identifier: Apache-2.0
//
// Bug: hooks send `contentSessionId` (the client-generated session id) on
// every agent event, but never `serverSessionId` (they don't know the
// server's UUID). `toAgentEventInput` discarded `contentSessionId` entirely,
// so `agent_events.server_session_id` was always NULL and the gitUser copy
// in `processGeneratedResponse` (which reads it off the linked session) never
// fired. The fix: when `serverSessionId` is absent, resolve it by looking up
// `server_sessions` on (project_id, external_session_id) — which equals
// content_session_id, see session-init.ts — scoped to the caller's team.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { createHash, randomBytes } from 'crypto';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerBetaPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { DisabledServerBetaQueueManager } from '../../src/server/runtime/types.js';
import { logger } from '../../src/utils/logger.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function newApiKey(): { raw: string; hash: string } {
  const raw = `cm_${randomBytes(24).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

describe('agent event -> server session linking', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;
  let teamId: string;
  let projectId: string;
  let apiKeyRaw: string;
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
    schemaName = `cm_evt_session_link_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerBetaPostgresSchema(client);
    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;

    const { raw, hash } = newApiKey();
    apiKeyRaw = raw;
    await storage.auth.createApiKey({
      keyHash: hash,
      teamId,
      projectId,
      actorId: 'test',
      scopes: ['memories:read', 'memories:write'],
    });

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never,
      queueManager: new DisabledServerBetaQueueManager('disabled in tests'),
      authMode: 'api-key',
      runtime: 'server-beta',
      sessionPolicy: 'per-event',
      getEventQueue: () => null,
      getSummaryQueue: () => null,
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${apiKeyRaw}`,
        'Content-Type': 'application/json',
      },
    });
  }

  // Count queries issued directly against server_sessions (the lookup this
  // fix adds), so the batch test can prove dedup rather than just correctness.
  function countServerSessionLookups(spy: ReturnType<typeof spyOn>): number {
    return spy.mock.calls.filter(([text]) => String(text).includes('FROM server_sessions')).length;
  }

  it('an explicit serverSessionId wins over contentSessionId', async () => {
    const explicitSession = await storage.sessions.create({
      projectId,
      teamId,
      externalSessionId: 'ext-explicit',
    });
    const decoySession = await storage.sessions.create({
      projectId,
      teamId,
      externalSessionId: 'ext-decoy',
    });

    const resp = await authedFetch('/v1/events', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        serverSessionId: explicitSession.id,
        contentSessionId: 'ext-decoy',
        sourceType: 'api',
        eventType: 'tool_use',
        payload: {},
        occurredAtEpoch: Date.now(),
      }),
    });
    expect(resp.status).toBe(201);
    const { event } = await resp.json();
    expect(event.serverSessionId).toBe(explicitSession.id);
    expect(event.serverSessionId).not.toBe(decoySession.id);
  });

  it('resolves serverSessionId from contentSessionId when serverSessionId is absent', async () => {
    const session = await storage.sessions.create({
      projectId,
      teamId,
      externalSessionId: 'ext-resolve-me',
    });

    const resp = await authedFetch('/v1/events', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        contentSessionId: 'ext-resolve-me',
        sourceType: 'hook',
        eventType: 'tool_use',
        payload: {},
        occurredAtEpoch: Date.now(),
      }),
    });
    expect(resp.status).toBe(201);
    const { event } = await resp.json();
    expect(event.serverSessionId).toBe(session.id);
  });

  it('a lookup miss leaves serverSessionId null and still ingests the event', async () => {
    const resp = await authedFetch('/v1/events', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        contentSessionId: 'ext-does-not-exist-yet',
        sourceType: 'hook',
        eventType: 'tool_use',
        payload: {},
        occurredAtEpoch: Date.now(),
      }),
    });
    expect(resp.status).toBe(201);
    const { event } = await resp.json();
    expect(event.serverSessionId).toBeNull();
  });

  it('batch resolves a shared contentSessionId with a single lookup, not one per event', async () => {
    const session = await storage.sessions.create({
      projectId,
      teamId,
      externalSessionId: 'ext-shared-batch',
    });

    const querySpy = spyOn(pool, 'query');
    const eventCount = 5;
    const resp = await authedFetch('/v1/events/batch', {
      method: 'POST',
      body: JSON.stringify(
        Array.from({ length: eventCount }, (_, i) => ({
          projectId,
          contentSessionId: 'ext-shared-batch',
          sourceType: 'hook',
          eventType: 'tool_use',
          payload: { i },
          occurredAtEpoch: Date.now(),
        }))
      ),
    });
    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.events).toHaveLength(eventCount);
    for (const { event } of body.events) {
      expect(event.serverSessionId).toBe(session.id);
    }

    // 5 events sharing one contentSessionId must resolve via exactly one
    // server_sessions lookup, not 5.
    expect(countServerSessionLookups(querySpy)).toBe(1);
    querySpy.mockRestore();
  });

  it('scopes the contentSessionId lookup to the caller project — never crosses tenant boundaries', async () => {
    // A foreign project (different team entirely) has a session with the
    // SAME externalSessionId value. The lookup must not leak across it.
    const otherTeam = await storage.teams.create({ name: 'other-team' });
    const otherProject = await storage.projects.create({ teamId: otherTeam.id, name: 'other-p' });
    const foreignSession = await storage.sessions.create({
      projectId: otherProject.id,
      teamId: otherTeam.id,
      externalSessionId: 'ext-shared-name',
    });

    const ownSession = await storage.sessions.create({
      projectId,
      teamId,
      externalSessionId: 'ext-shared-name',
    });

    const resp = await authedFetch('/v1/events', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        contentSessionId: 'ext-shared-name',
        sourceType: 'hook',
        eventType: 'tool_use',
        payload: {},
        occurredAtEpoch: Date.now(),
      }),
    });
    expect(resp.status).toBe(201);
    const { event } = await resp.json();
    expect(event.serverSessionId).toBe(ownSession.id);
    expect(event.serverSessionId).not.toBe(foreignSession.id);
  });
});
