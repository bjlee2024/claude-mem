import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCa } from '../../../src/server/security/ca.js';
import { writeCaMaterial } from '../../../src/server/security/ca-store.js';
import { caSignerFromEnv } from '../../../src/server/runtime/ServerBetaService.js';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('caSignerFromEnv', () => {
  it('returns null when CA env is unset', () => {
    expect(caSignerFromEnv({})).toBeNull();
  });
  it('loads a signer from configured files', () => {
    dir = mkdtempSync(join(tmpdir(), 'ca-env-'));
    const paths = writeCaMaterial(dir, createCa({ commonName: 'c', days: 3650 }));
    const signer = caSignerFromEnv({ CLAUDE_MEM_CA_CERT_FILE: paths.certFile, CLAUDE_MEM_CA_KEY_FILE: paths.keyFile, CLAUDE_MEM_WORKER_CERT_TTL_DAYS: '7' });
    expect(signer).not.toBeNull();
  });
});
