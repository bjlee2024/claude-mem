// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { bootstrapServerBetaPostgresSchema } from '../../../src/storage/postgres/index.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
function quoteIdentifier(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

describe('projects UNIQUE (team_id, name)', () => {
  if (!testDatabaseUrl) { it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {}); return; }
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let schema: string;
  let teamId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schema = `cm_uq_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await bootstrapServerBetaPostgresSchema(client);
    teamId = crypto.randomUUID();
    await client.query("INSERT INTO teams (id, name) VALUES ($1, 'T')", [teamId]);
  });
  afterEach(async () => {
    try { await client.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`); } catch { /* ignore */ }
    client.release(); await pool.end();
  });

  it('rejects a duplicate (team_id, name)', async () => {
    expect.assertions(1);
    await client.query('INSERT INTO projects (id, team_id, name) VALUES ($1,$2,$3)', [crypto.randomUUID(), teamId, 'dup']);
    await expect(
      client.query('INSERT INTO projects (id, team_id, name) VALUES ($1,$2,$3)', [crypto.randomUUID(), teamId, 'dup'])
    ).rejects.toThrow(/unique|duplicate/i);
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
