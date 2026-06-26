// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildRedisTls } from '../../../src/server/queue/redis-config.js';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('buildRedisTls', () => {
  it('returns {} for rediss when no cert files are configured', () => {
    expect(buildRedisTls('rediss:', {})).toEqual({});
  });
  it('returns undefined for plain redis', () => {
    expect(buildRedisTls('redis:', {})).toBeUndefined();
  });
  it('loads ca/cert/key file contents for mTLS', () => {
    dir = mkdtempSync(join(tmpdir(), 'redis-tls-'));
    const ca = join(dir, 'ca'); const cert = join(dir, 'crt'); const key = join(dir, 'key');
    writeFileSync(ca, 'CA'); writeFileSync(cert, 'CERT'); writeFileSync(key, 'KEY');
    const tls = buildRedisTls('rediss:', { CLAUDE_MEM_REDIS_TLS_CA_FILE: ca, CLAUDE_MEM_REDIS_TLS_CERT_FILE: cert, CLAUDE_MEM_REDIS_TLS_KEY_FILE: key }) as Record<string, string>;
    expect(tls.ca).toBe('CA'); expect(tls.cert).toBe('CERT'); expect(tls.key).toBe('KEY');
  });
});
