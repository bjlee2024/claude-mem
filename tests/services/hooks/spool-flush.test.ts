// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { makeSpoolSender } from '../../../src/services/hooks/spool-flush.js';
import { ServerBetaClientError } from '../../../src/services/hooks/server-beta-client.js';

describe('makeSpoolSender', () => {
  const baseRecord = { id: 'e1', kind: 'event' as const, endpoint: '/v1/events', body: { eventType: 'tool_use', payload: {}, contentSessionId: 's', sourceEventId: 'e1' }, projectName: 'p', enqueuedAtEpoch: 1 };

  it('resolves projectName then posts; ok on success', async () => {
    const client = { resolveProject: async () => 'pid', recordEvent: async () => ({ event: { id: 'x' } }) } as any;
    const send = makeSpoolSender({ client });
    expect(await send(baseRecord)).toEqual({ ok: true });
  });

  it('classifies eligible error as retryable (ok:false, permanent:false)', async () => {
    const client = { resolveProject: async () => 'pid', recordEvent: async () => { throw new ServerBetaClientError('timeout', 't'); } } as any;
    const send = makeSpoolSender({ client });
    expect(await send(baseRecord)).toEqual({ ok: false, permanent: false });
  });

  it('classifies non-eligible (e.g. 4xx) as permanent', async () => {
    const client = { resolveProject: async () => 'pid', recordEvent: async () => { throw new ServerBetaClientError('http_error', 'bad', { status: 400 }); } } as any;
    const send = makeSpoolSender({ client });
    expect(await send(baseRecord)).toEqual({ ok: false, permanent: true });
  });
});
