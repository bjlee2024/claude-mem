import { describe, it, expect } from 'bun:test';
import { ServerBetaClient } from '../../src/services/hooks/server-beta-client.js';

describe('ServerBetaClient.forwardLogs', () => {
  it('POSTs lines to /v1/logs/ingest and swallows network errors', async () => {
    const calls: { url: string; body: any }[] = [];
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 204, text: async () => '' } as any;
    };
    const client = new ServerBetaClient({ serverBaseUrl: 'http://x:1', apiKey: 'k', fetchImpl: fakeFetch as any });
    await client.forwardLogs(['[..] [WARN ] [HOOK] hi']);
    expect(calls[0].url).toContain('/v1/logs/ingest');
    expect(calls[0].body.lines[0]).toContain('hi');

    const boom = new ServerBetaClient({ serverBaseUrl: 'http://x:1', apiKey: 'k', fetchImpl: (async () => { throw new Error('down'); }) as any });
    await boom.forwardLogs(['x']); // must NOT throw
  });
});
