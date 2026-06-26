import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initCa } from '../../src/npx-cli/commands/server-ca.js';
import forge from 'node-forge';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('initCa', () => {
  it('writes ca.crt/ca.key plus a server cert with valkey in SAN', () => {
    dir = mkdtempSync(join(tmpdir(), 'ca-init-'));
    const result = initCa({ dir, dnsNames: ['valkey', 'localhost'], caDays: 3650, serverDays: 365 });
    expect(existsSync(result.caCertFile)).toBe(true);
    expect(existsSync(result.caKeyFile)).toBe(true);
    expect(existsSync(result.serverCertFile)).toBe(true);
    expect(existsSync(result.serverKeyFile)).toBe(true);
    const server = forge.pki.certificateFromPem(readFileSync(result.serverCertFile, 'utf8'));
    const san = server.getExtension('subjectAltName') as { altNames: { value: string }[] } | undefined;
    expect(san?.altNames.map(a => a.value)).toContain('valkey');
  });
});
