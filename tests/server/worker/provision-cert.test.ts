import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { provisionWorkerCert } from '../../../src/server/worker/provision-cert.js';
import { createCa } from '../../../src/server/security/ca.js';
import { loadCaSigner, writeCaMaterial } from '../../../src/server/security/ca-store.js';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function signerFetch(signer: ReturnType<typeof loadCaSigner>) {
  return async (_url: string, init: { body?: string }) => {
    const { csr, commonName } = JSON.parse(init.body!);
    const out = signer!.sign(csr, commonName);
    return { ok: true, status: 201, text: async () => JSON.stringify({ cert: out.certPem, ca: out.caPem, serial: out.serial, notAfter: out.notAfter.toISOString() }) } as never;
  };
}

describe('provisionWorkerCert', () => {
  it('issues + writes key/cert/ca on first run', async () => {
    dir = mkdtempSync(join(tmpdir(), 'prov-'));
    const ca = createCa({ commonName: 'c', days: 3650 });
    const paths = writeCaMaterial(dir, ca);
    const signer = loadCaSigner({ ...paths, ttlDays: 7 })!;
    const out = await provisionWorkerCert({
      dir: join(dir, 'worker'), commonName: 'worker-1', serverUrl: 'http://s', apiKey: 'cmem_x',
      fetchImpl: signerFetch(signer) as never, renewWithinDays: 2,
    });
    expect(out.action).toBe('issued');
    expect(existsSync(out.keyFile)).toBe(true);
    expect(readFileSync(out.certFile, 'utf8')).toContain('BEGIN CERTIFICATE');
    expect(readFileSync(out.caFile, 'utf8')).toBe(ca.certPem);
  });

  it('skips when an existing cert is far from expiry', async () => {
    dir = mkdtempSync(join(tmpdir(), 'prov2-'));
    const ca = createCa({ commonName: 'c', days: 3650 });
    const paths = writeCaMaterial(dir, ca);
    const signer = loadCaSigner({ ...paths, ttlDays: 7 })!;
    const opts = { dir: join(dir, 'worker'), commonName: 'worker-1', serverUrl: 'http://s', apiKey: 'cmem_x', fetchImpl: signerFetch(signer) as never, renewWithinDays: 2 };
    await provisionWorkerCert(opts);
    const second = await provisionWorkerCert(opts);
    expect(second.action).toBe('reused');
  });
});
