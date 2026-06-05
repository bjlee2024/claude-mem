// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'bun:test';
import { ServerBetaClient } from '../../../src/services/hooks/server-beta-client.js';

describe('ServerBetaClient.resolveProject', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('POSTs /v1/projects/resolve and returns the id', async () => {
    let captured: { url: string; body: any } | null = null;
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ id: 'p-uuid' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as any;
    const c = new ServerBetaClient({ serverBaseUrl: 'http://h:1', apiKey: 'k' });
    const id = await c.resolveProject('repo-a');
    expect(id).toBe('p-uuid');
    expect(captured!.url).toContain('/v1/projects/resolve');
    expect(captured!.body).toEqual({ name: 'repo-a' });
  });
});
