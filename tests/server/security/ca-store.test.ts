import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeCaMaterial, loadCaSigner } from '../../../src/server/security/ca-store.js';
import { createCa } from '../../../src/server/security/ca.js';
import { generateKeyAndCsr } from '../../../src/shared/mtls/csr.js';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('ca-store', () => {
  it('persists CA material and loads a working signer', () => {
    dir = mkdtempSync(join(tmpdir(), 'ca-store-'));
    const ca = createCa({ commonName: 'test CA', days: 3650 });
    const paths = writeCaMaterial(dir, ca);
    const signer = loadCaSigner({ certFile: paths.certFile, keyFile: paths.keyFile, ttlDays: 7 });
    expect(signer).not.toBeNull();
    const { csrPem } = generateKeyAndCsr({ commonName: 'worker-x' });
    const out = signer!.sign(csrPem, 'worker-x');
    expect(out.certPem).toContain('BEGIN CERTIFICATE');
    expect(out.caPem).toBe(ca.certPem);
  });

  it('loadCaSigner returns null when files are absent', () => {
    expect(loadCaSigner({ certFile: '/nope/ca.crt', keyFile: '/nope/ca.key', ttlDays: 7 })).toBeNull();
  });
});
