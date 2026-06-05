// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — `server enroll` mints a TEAM-scoped API key
// (project_id NULL, memories:read/write) and returns a one-line enrollment
// token. This verifies the testable core: createEnrollment().

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerBetaPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
} from '../../src/storage/postgres/index.js';
import { createEnrollment } from '../../src/npx-cli/commands/server-enroll.js';
import { decodeEnrollment } from '../../src/services/hooks/enrollment.js';

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('createEnrollment', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let teamId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = (await pool.connect()) as PostgresPoolClient;
    schemaName = `cm_enroll_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerBetaPostgresSchema(client);

    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'enroll-team' });
    teamId = team.id;
  });

  afterEach(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('mints a team-scoped key (project_id NULL) with memories scopes and returns a decodable token', async () => {
    const result = await createEnrollment({
      pool: client,
      teamId,
      serverUrl: 'https://host:37700',
      label: 'laptop',
    });

    expect(typeof result.rawKey).toBe('string');
    expect(result.rawKey.length).toBeGreaterThan(0);
    expect(typeof result.apiKeyId).toBe('string');
    expect(result.apiKeyId.length).toBeGreaterThan(0);

    // Newest api_keys row must be team-scoped with the memories scopes.
    const row = await client.query<{ project_id: string | null; scopes: unknown }>(
      `SELECT project_id, scopes FROM api_keys ORDER BY created_at DESC LIMIT 1`,
    );
    expect(row.rows[0]).toBeDefined();
    expect(row.rows[0].project_id).toBeNull();
    const scopes = row.rows[0].scopes as string[];
    expect(scopes).toContain('memories:read');
    expect(scopes).toContain('memories:write');

    // The token round-trips to the server URL + the raw key.
    expect(decodeEnrollment(result.token)).toEqual({
      url: 'https://host:37700',
      key: result.rawKey,
    });
  });
});
