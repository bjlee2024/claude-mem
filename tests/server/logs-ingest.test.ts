// SPDX-License-Identifier: Apache-2.0
//
// TDD: POST /v1/logs/ingest + GET /api/logs integration test.
// Bootstrap pattern mirrors tests/server/v1-routes.test.ts (Server + ServerV1Routes).

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import { ServerV1Routes } from '../../src/server/routes/v1/ServerV1Routes.js';
import { createServerApiKey } from '../../src/server/auth/sqlite-api-key-service.js';
import { logger } from '../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('POST /v1/logs/ingest', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let writeKey: string;

  beforeEach(async () => {
    // Suppress logger I/O — ingestExternalLogs bypasses these methods and
    // writes directly to the ring buffer, so mocking them doesn't affect the
    // assertions.
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    // Start each test with a clean ring buffer so earlier test runs don't pollute
    // the GET /api/logs assertion.
    logger.clearRecentLogs();

    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');

    // createServerApiKey bootstraps the SQLite schema automatically.
    const created = createServerApiKey(db, {
      name: 'test-write-key',
      scopes: ['memories:write'],
    });
    writeKey = created.rawKey;

    const options: ServerOptions = {
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({
        provider: 'claude',
        authMethod: 'api-key',
        lastInteraction: null,
      }),
    };
    server = new Server(options);
    server.registerRoutes(
      new ServerV1Routes({ getDatabase: () => db, authMode: 'api-key' }),
    );
    // Inline /api/logs viewer shim — mirrors ServerViewerDataRoutes.setupRoutes's
    // one-liner without pulling in the full Postgres-backed class.
    server.registerRoutes({
      setupRoutes(app) {
        app.get('/api/logs', (_req, res) => {
          res.json({ logs: logger.getRecentLogs() });
        });
      },
    });
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected server to bind to an ephemeral TCP port');
    }
    port = address.port;
  });

  afterEach(async () => {
    try {
      await server.close();
    } catch (error: any) {
      if (error?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    db.close();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Happy path: authenticated POST → lines land in GET /api/logs as [client]
  // ──────────────────────────────────────────────────────────────────────────
  it('authed POST succeeds (204) and ingested lines appear in GET /api/logs tagged [client]', async () => {
    const testLine = '[2026-06-29 12:00:00.000] [WARN ] [HOOK  ] [server] client-side warning for test';

    const res = await fetch(`http://127.0.0.1:${port}/v1/logs/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${writeKey}`,
      },
      body: JSON.stringify({ lines: [testLine] }),
    });
    expect(res.status).toBe(204);

    const logsRes = await fetch(`http://127.0.0.1:${port}/api/logs`);
    expect(logsRes.status).toBe(200);
    const { logs } = await logsRes.json() as { logs: string };
    expect(logs).toContain('[client]');
    expect(logs).toContain('client-side warning for test');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Auth guard: no token → 401
  // ──────────────────────────────────────────────────────────────────────────
  it('rejects unauthenticated POST with 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/logs/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: ['unauthenticated line'] }),
    });
    expect(res.status).toBe(401);
  });
});
