import { describe, it, expect } from 'bun:test';
import { createWorkerEnrollment, WORKER_ENROLL_SCOPES } from '../../src/npx-cli/commands/server-worker-enroll.js';
import { decodeEnrollment } from '../../src/services/hooks/enrollment.js';

describe('createWorkerEnrollment', () => {
  it('mints a certs:issue-scoped key and returns an enroll token', async () => {
    const created: { scopes?: unknown[] }[] = [];
    const fakePool = { query: async () => ({ rows: [] }) } as never;
    const result = await createWorkerEnrollment({
      pool: fakePool,
      teamId: 't1',
      serverUrl: 'http://server:37700',
      repo: { createApiKey: async (i: { scopes?: unknown[] }) => { created.push(i); return { id: 'k1' }; }, createAuditLog: async () => {} } as never,
    });
    expect(created[0].scopes).toContain('certs:issue');
    expect(WORKER_ENROLL_SCOPES).toContain('certs:issue');
    const decoded = decodeEnrollment(result.token);
    expect(decoded.url).toBe('http://server:37700');
    expect(result.rawKey).toMatch(/^cmem_/);
  });
});
