// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientWriter } from '../../../src/services/hooks/client-write.js';
import { Spool } from '../../../src/services/hooks/spool.js';
import { ServerBetaClientError } from '../../../src/services/hooks/server-beta-client.js';

describe('ClientWriter', () => {
  let dir: string; let spool: Spool;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cm-cw-')); spool = new Spool({ path: join(dir, 's.ndjson') }); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const resolver = { resolve: async (_cwd: string) => 'pid-1' } as any;

  it('on eligible failure, spools the write and never throws', async () => {
    const client = { recordEvent: async () => { throw new ServerBetaClientError('timeout', 'slow'); } } as any;
    const w = new ClientWriter({ client, resolver, spool });
    await w.recordToolUse({ cwd: '/x/repo', sessionId: 's', sourceEventId: 'e1', payload: {} });
    expect(spool.depth()).toBe(1);
    expect(spool.peekIds()).toEqual(['e1']);
  });

  it('on success, does not spool', async () => {
    const client = { recordEvent: async () => ({ event: { id: 'x' } }) } as any;
    const w = new ClientWriter({ client, resolver, spool });
    await w.recordToolUse({ cwd: '/x/repo', sessionId: 's', sourceEventId: 'e1', payload: {} });
    expect(spool.depth()).toBe(0);
  });
});
