// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerBetaPostgresSchema,
  createPostgresStorageRepositories,
} from '../../../../src/storage/postgres/index.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

// Regression: tool output quoting source code with a NUL byte made every
// agent_events INSERT fail with "unsupported Unicode escape sequence".
describe('agent_events — U+0000 in payload/metadata', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL for Postgres integration', () => {});
    return;
  }

  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  afterAll(async () => { await pool.end(); });

  it('stores an event whose payload and metadata contain NUL', async () => {
    const client = await pool.connect();
    const schema = `cm_nul_${crypto.randomUUID().replaceAll('-', '_')}`;
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await bootstrapServerBetaPostgresSchema(client);
      const storage = createPostgresStorageRepositories(client);
      const team = await storage.teams.create({ name: 'team-nul' });
      const project = await storage.projects.create({ teamId: team.id, name: 'proj-nul' });

      const event = await storage.agentEvents.create({
        projectId: project.id,
        teamId: team.id,
        sourceAdapter: 'api',
        eventType: 'tool_use',
        payload: { tool_response: 'return `${projectId}\u0000${contentSessionId}`', ['k\u0000']: 1 },
        metadata: { note: 'a\u0000b' },
        occurredAt: new Date(),
      });

      const stored = await storage.agentEvents.getByIdForScope({
        id: event.id, projectId: project.id, teamId: team.id,
      });
      expect(stored?.payload).toEqual({
        tool_response: 'return `${projectId}�${contentSessionId}`',
        ['k�']: 1,
      });
      expect(stored?.metadata).toEqual({ note: 'a�b' });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      client.release();
    }
  });
});
