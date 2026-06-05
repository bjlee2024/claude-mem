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

  it('recordEvent with custom eventType spools on eligible failure with that eventType in body', async () => {
    const client = { recordEvent: async () => { throw new ServerBetaClientError('transport', 'conn refused'); } } as any;
    const w = new ClientWriter({ client, resolver, spool });
    await w.recordEvent({ cwd: '/x/repo', sessionId: 's', sourceEventId: 'e2', eventType: 'assistant_message', payload: { last_assistant_message: 'hello' } });
    expect(spool.depth()).toBe(1);
    expect(spool.peekIds()).toEqual(['e2']);
    // Flush with a capturing sender to inspect the spooled record body
    const captured: import('../../../src/services/hooks/spool.js').SpoolRecord[] = [];
    await spool.flush(async (r) => { captured.push(r); return { ok: true }; });
    expect(captured.length).toBe(1);
    expect((captured[0].body as Record<string, unknown>).eventType).toBe('assistant_message');
  });
});
