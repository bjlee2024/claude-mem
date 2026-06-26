import { describe, it, expect } from 'bun:test';
import { PostgresWorkerCertsRepository } from '../../../../src/storage/postgres/worker-certs.js';

function fakeClient(rows: Record<string, unknown>[]) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows, rowCount: rows.length } as never;
    },
  };
}

describe('PostgresWorkerCertsRepository', () => {
  it('record() inserts and maps the row', async () => {
    const now = new Date();
    const client = fakeClient([{ id: 'wc1', team_id: 't1', api_key_id: 'k1', common_name: 'worker-1', serial: '0a', fingerprint_sha256: 'ff', not_after: now, revoked_at: null, issued_at: now }]);
    const repo = new PostgresWorkerCertsRepository(client);
    const rec = await repo.record({ teamId: 't1', apiKeyId: 'k1', commonName: 'worker-1', serial: '0a', fingerprintSha256: 'ff', notAfter: now });
    expect(rec.id).toBe('wc1');
    expect(rec.commonName).toBe('worker-1');
    expect(client.calls[0].text).toContain('INSERT INTO worker_certs');
  });
});
