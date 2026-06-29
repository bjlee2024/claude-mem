// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { PostgresProjectsRepository } from '../../src/storage/postgres/projects.js';

/**
 * Fake PostgresQueryable that matches queries by SQL regex + optional param predicate.
 * Supports named entries so multiple responses can coexist for the same SQL pattern.
 */
function fakeClient(
  script: Array<{ matchSql: RegExp; matchParams?: (p: unknown[]) => boolean; rows: unknown[] }>
) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const hit = script.find(
        (s) => s.matchSql.test(sql) && (!s.matchParams || s.matchParams(params))
      );
      return { rows: hit ? hit.rows : [] };
    },
  };
}

const SELECT_PROJECT = /SELECT .* FROM projects WHERE/i;
const UPDATE_NAME = /UPDATE projects SET name/i;
const UPDATE_REF = /UPDATE \w+ SET project_id/i;
const DELETE_PROJECT = /DELETE FROM projects WHERE id/i;
const TRANSACTION = /^(BEGIN|COMMIT|ROLLBACK)$/i;

describe('renameOrMerge', () => {
  it('returns null when "from" project does not exist', async () => {
    // SELECT returns no rows for "from"
    const c = fakeClient([{ matchSql: SELECT_PROJECT, rows: [] }]);
    const repo = new PostgresProjectsRepository(c as any);
    const result = await repo.renameOrMerge('team1', 'missing', 'new');
    expect(result).toBeNull();
    // Only one SELECT query should have been issued
    const selects = c.calls.filter((q) => SELECT_PROJECT.test(q.sql));
    expect(selects.length).toBe(1);
  });

  it('renames when "to" name is free (no merge)', async () => {
    const c = fakeClient([
      // First SELECT (looking for "from") → found
      {
        matchSql: SELECT_PROJECT,
        matchParams: (p) => p[1] === 'old',
        rows: [{ id: 'from-id' }],
      },
      // Second SELECT (looking for "to") → not found
      {
        matchSql: SELECT_PROJECT,
        matchParams: (p) => p[1] === 'new',
        rows: [],
      },
      // UPDATE projects SET name ...
      { matchSql: UPDATE_NAME, rows: [{ id: 'from-id' }] },
    ]);
    const repo = new PostgresProjectsRepository(c as any);
    const result = await repo.renameOrMerge('team1', 'old', 'new');
    expect(result).toEqual({ id: 'from-id', name: 'new', merged: false });

    // An UPDATE on projects table (name rename) must have happened
    const nameUpdates = c.calls.filter((q) => UPDATE_NAME.test(q.sql));
    expect(nameUpdates.length).toBe(1);
    // No transaction commands (simple rename does not use BEGIN/COMMIT)
    const txCmds = c.calls.filter((q) => TRANSACTION.test(q.sql));
    expect(txCmds.length).toBe(0);
    // No reference table UPDATEs
    const refUpdates = c.calls.filter((q) => UPDATE_REF.test(q.sql));
    expect(refUpdates.length).toBe(0);
  });

  it('merges when "to" project already exists', async () => {
    // All 6 tables with project_id FK (schema.ts lines 112,140,154,175,194,229)
    const expectedReferencingTables = [
      'api_keys',
      'audit_log',
      'server_sessions',
      'agent_events',
      'observation_generation_jobs',
      'observations',
    ];

    const c = fakeClient([
      // SELECT for "from" → found
      {
        matchSql: SELECT_PROJECT,
        matchParams: (p) => p[1] === 'alpha',
        rows: [{ id: 'from-id' }],
      },
      // SELECT for "to" → found
      {
        matchSql: SELECT_PROJECT,
        matchParams: (p) => p[1] === 'beta',
        rows: [{ id: 'to-id' }],
      },
    ]);
    const repo = new PostgresProjectsRepository(c as any);
    const result = await repo.renameOrMerge('team1', 'alpha', 'beta');
    expect(result).toEqual({ id: 'to-id', name: 'beta', merged: true });

    // Transaction wrapping: BEGIN → SET CONSTRAINTS ALL DEFERRED → ... → COMMIT
    const sqlSeq = c.calls.map((q) => q.sql.trim().toUpperCase());
    expect(sqlSeq).toContain('BEGIN');
    expect(sqlSeq).toContain('SET CONSTRAINTS ALL DEFERRED');
    expect(sqlSeq).toContain('COMMIT');
    expect(sqlSeq).not.toContain('ROLLBACK');
    // SET CONSTRAINTS must come immediately after BEGIN
    const beginIdx = sqlSeq.indexOf('BEGIN');
    const setConstraintsIdx = sqlSeq.indexOf('SET CONSTRAINTS ALL DEFERRED');
    expect(setConstraintsIdx).toBe(beginIdx + 1);

    // Every referencing table must have received an UPDATE SET project_id
    const refUpdates = c.calls.filter((q) => UPDATE_REF.test(q.sql));
    expect(refUpdates.length).toBe(expectedReferencingTables.length);
    for (const table of expectedReferencingTables) {
      const found = refUpdates.find((q) => q.sql.includes(table));
      expect(found).toBeDefined();
      // Each UPDATE scoped by both project_id and team_id (composite FK safety)
      expect(found!.sql).toMatch(/WHERE project_id = \$2 AND team_id = \$3/i);
      expect(found!.params).toEqual(['to-id', 'from-id', 'team1']);
    }

    // FROM project row must be deleted
    const deletes = c.calls.filter((q) => DELETE_PROJECT.test(q.sql));
    expect(deletes.length).toBe(1);
    expect(deletes[0].params).toEqual(['from-id']);

    // No name rename should have happened
    const nameUpdates = c.calls.filter((q) => UPDATE_NAME.test(q.sql));
    expect(nameUpdates.length).toBe(0);
  });

  it('guards against same-id merge (data loss on rename-to-self)', async () => {
    // Both "from" and "to" name lookups resolve to the same project id.
    // This can occur when the user tries to rename to the same name via different
    // code paths or race conditions. Must NOT enter merge transaction or delete.
    const c = fakeClient([
      // SELECT for "from" → found
      {
        matchSql: SELECT_PROJECT,
        matchParams: (p) => p[1] === 'original',
        rows: [{ id: 'same-id' }],
      },
      // SELECT for "to" → found with SAME id
      {
        matchSql: SELECT_PROJECT,
        matchParams: (p) => p[1] === 'also-same',
        rows: [{ id: 'same-id' }],
      },
    ]);
    const repo = new PostgresProjectsRepository(c as any);
    const result = await repo.renameOrMerge('team1', 'original', 'also-same');
    // Should return early without merging
    expect(result).toEqual({ id: 'same-id', name: 'also-same', merged: false });

    // No transaction commands should be issued
    const txCmds = c.calls.filter((q) => TRANSACTION.test(q.sql));
    expect(txCmds.length).toBe(0);
    // No DELETE query should be issued
    const deletes = c.calls.filter((q) => DELETE_PROJECT.test(q.sql));
    expect(deletes.length).toBe(0);
    // No reference table UPDATEs
    const refUpdates = c.calls.filter((q) => UPDATE_REF.test(q.sql));
    expect(refUpdates.length).toBe(0);
    // No name UPDATE (simple return, not even a rename)
    const nameUpdates = c.calls.filter((q) => UPDATE_NAME.test(q.sql));
    expect(nameUpdates.length).toBe(0);
  });

  it('rolls back and rethrows on mid-merge error', async () => {
    const c = fakeClient([
      { matchSql: SELECT_PROJECT, matchParams: (p) => p[1] === 'src', rows: [{ id: 'src-id' }] },
      { matchSql: SELECT_PROJECT, matchParams: (p) => p[1] === 'dst', rows: [{ id: 'dst-id' }] },
    ]);
    // Override query to throw on the first reference UPDATE; capture ALL calls
    // (including the failing one) in a dedicated array so we can assert ROLLBACK.
    const queryCalls: { sql: string; params: unknown[] }[] = [];
    const origQuery = c.query.bind(c);
    (c as any).query = async (sql: string, params: unknown[] = []) => {
      queryCalls.push({ sql, params });
      if (UPDATE_REF.test(sql)) {
        throw new Error('simulated DB error');
      }
      return origQuery(sql, params);
    };

    const repo = new PostgresProjectsRepository(c as any);
    await expect(repo.renameOrMerge('team1', 'src', 'dst')).rejects.toThrow('simulated DB error');

    // ROLLBACK must have been issued after the failed UPDATE
    const sqlSeq = queryCalls.map((q) => q.sql.trim().toUpperCase());
    expect(sqlSeq).toContain('BEGIN');
    expect(sqlSeq).toContain('ROLLBACK');
    expect(sqlSeq).not.toContain('COMMIT');
    // ROLLBACK must come after the first failing UPDATE
    const firstUpdateIdx = sqlSeq.findIndex((s) => UPDATE_REF.test(s));
    const rollbackIdx = sqlSeq.indexOf('ROLLBACK');
    expect(firstUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(rollbackIdx).toBeGreaterThan(firstUpdateIdx);
  });
});
