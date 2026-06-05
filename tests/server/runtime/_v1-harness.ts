// SPDX-License-Identifier: Apache-2.0
// Shared test harness for ServerV1PostgresRoutes integration tests.

import pg from 'pg';
import { createHash, randomBytes } from 'crypto';
import { mock, spyOn } from 'bun:test';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerBetaPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { DisabledServerBetaQueueManager } from '../../../src/server/runtime/types.js';
import { logger } from '../../../src/utils/logger.js';

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function newApiKey(): { raw: string; hash: string } {
  const raw = `cm_${randomBytes(24).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/**
 * Create a team-scoped api key (project_id NULL) for the given teamId.
 * Returns the plaintext raw key.
 */
export async function createTeamScopedKey(
  storage: PostgresStorageRepositories,
  teamId: string,
  label?: string,
): Promise<string> {
  const material = newApiKey();
  await storage.auth.createApiKey({
    keyHash: material.hash,
    teamId,
    projectId: null,
    actorId: label ?? 'system:v1-harness-team-key',
    scopes: ['memories:read', 'memories:write'],
  });
  return material.raw;
}

export interface V1ServerContext {
  port: number;
  client: PostgresPoolClient;
  teamId: string;
  projectId: string;
  teamScopedKey: string;
  authedPost: (path: string, body: unknown) => Promise<Response>;
  close: () => Promise<void>;
}

/**
 * Start an isolated V1 postgres server with a freshly bootstrapped schema.
 * Returns helpers for the test and a close() that tears everything down.
 */
export async function startV1Server(): Promise<V1ServerContext> {
  const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
  if (!testDatabaseUrl) {
    throw new Error('CLAUDE_MEM_TEST_POSTGRES_URL is not set');
  }

  const loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
  ];

  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  const client = (await pool.connect()) as PostgresPoolClient;
  const schemaName = `cm_v1h_${crypto.randomUUID().replaceAll('-', '_')}`;

  await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
  await bootstrapServerBetaPostgresSchema(client);
  pool.on('connect', (poolClient) => {
    poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
  });

  const storage = createPostgresStorageRepositories(client);

  const team = await storage.teams.create({ name: 'harness-team' });
  const project = await storage.projects.create({ teamId: team.id, name: 'harness-project' });
  const teamScopedKey = await createTeamScopedKey(storage, team.id, 'system:v1-harness');

  const server = new Server({
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
  const port = address.port;

  const authedPost = (path: string, body: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${teamScopedKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  const close = async (): Promise<void> => {
    try { await server.close(); } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  };

  return {
    port,
    client,
    teamId: team.id,
    projectId: project.id,
    teamScopedKey,
    authedPost,
    close,
  };
}
