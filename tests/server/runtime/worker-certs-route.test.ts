import { describe, it, expect } from 'bun:test';
import { createCa } from '../../../src/server/security/ca.js';
import { loadCaSigner, writeCaMaterial } from '../../../src/server/security/ca-store.js';
import { generateKeyAndCsr } from '../../../src/shared/mtls/csr.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startV1Server } from './_v1-harness.js';

describe('POST /v1/worker-certs', () => {
  it('signs a CSR and returns { cert, ca } for a certs:issue key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-route-'));
    const ca = createCa({ commonName: 'test CA', days: 3650 });
    const paths = writeCaMaterial(dir, ca);
    const caSigner = loadCaSigner({ certFile: paths.certFile, keyFile: paths.keyFile, ttlDays: 7 })!;
    const recorded: unknown[] = [];
    const harness = await startV1Server({
      caSigner,
      workerCertsRepo: { record: async (i: unknown) => { recorded.push(i); return { id: 'wc1' }; } },
      apiKey: { rawKey: 'cmem_test', scopes: ['certs:issue'], teamId: 't1' },
    });
    try {
      const { csrPem } = generateKeyAndCsr({ commonName: 'worker-1' });
      const res = await fetch(`${harness.baseUrl}/v1/worker-certs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer cmem_test' },
        body: JSON.stringify({ commonName: 'worker-1', csr: csrPem }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.cert).toContain('BEGIN CERTIFICATE');
      expect(body.ca).toBe(ca.certPem);
      expect(recorded.length).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it('rejects a key without certs:issue with 403', async () => {
    const harness = await startV1Server({ apiKey: { rawKey: 'cmem_ro', scopes: ['memories:read'], teamId: 't1' } });
    try {
      const res = await fetch(`${harness.baseUrl}/v1/worker-certs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer cmem_ro' },
        body: JSON.stringify({ commonName: 'x', csr: 'x' }),
      });
      expect(res.status).toBe(403);
    } finally {
      await harness.close();
    }
  });
});
