// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { ClaudeSubscriptionObservationProvider } from '../../../src/server/generation/providers/ClaudeSubscriptionObservationProvider.js';
import type { ServerGenerationContext } from '../../../src/server/generation/providers/shared/types.js';

function makeContext(): ServerGenerationContext {
  return {
    job: { id: 'job-1' } as any,
    events: [
      {
        id: 'evt-1',
        projectId: 'p-1',
        teamId: 't-1',
        serverSessionId: null,
        sourceAdapter: 'api',
        sourceEventId: null,
        idempotencyKey: 'k',
        eventType: 'tool_use',
        platformSource: null,
        payload: { tool_name: 'Read', tool_input: { file_path: '/x' } },
        metadata: {},
        occurredAtEpoch: new Date('2026-06-05T00:00:00Z').getTime(),
        receivedAtEpoch: 0,
        createdAtEpoch: 0,
      } as any,
    ],
    project: { projectId: 'p-1', teamId: 't-1', serverSessionId: null, projectName: 'demo' },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const OK_BODY = {
  content: [{ type: 'text', text: '<observation>ok</observation>' }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe('ClaudeSubscriptionObservationProvider', () => {
  it('sends OAuth Bearer + anthropic-beta and NO x-api-key', async () => {
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const fetchImpl = (async (url: any, init: any) => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(init.headers)) h[k.toLowerCase()] = String(v);
      captured = { url: String(url), headers: h };
      return jsonResponse(OK_BODY);
    }) as unknown as typeof fetch;

    const provider = new ClaudeSubscriptionObservationProvider({ oauthToken: 'sk-ant-oat01-abc', fetchImpl });
    const result = await provider.generate(makeContext());

    expect(captured!.url).toContain('/v1/messages');
    expect(captured!.headers['authorization']).toBe('Bearer sk-ant-oat01-abc');
    expect(captured!.headers['anthropic-beta']).toBeTruthy();
    expect('x-api-key' in captured!.headers).toBe(false);
    expect(result.rawText).toBe('<observation>ok</observation>');
    expect(result.tokensUsed).toBe(15);
    expect(result.providerLabel).toBe('claude');
    expect(result.modelId).toBe('claude-sonnet-4-6');
  });

  it('throws auth_invalid on an empty or non-oauth token (constructor)', () => {
    expect(() => new ClaudeSubscriptionObservationProvider({ oauthToken: '' })).toThrow();
    expect(() => new ClaudeSubscriptionObservationProvider({ oauthToken: 'sk-ant-api03-notoauth' })).toThrow();
  });

  it('classifies a 401 as auth_invalid', async () => {
    const fetchImpl = (async () => jsonResponse({ error: { type: 'authentication_error', message: 'expired' } }, 401)) as unknown as typeof fetch;
    const provider = new ClaudeSubscriptionObservationProvider({ oauthToken: 'sk-ant-oat01-abc', fetchImpl });
    let kind = '';
    try { await provider.generate(makeContext()); } catch (e: any) { kind = e.kind; }
    expect(kind).toBe('auth_invalid');
  });

  it('classifies a 429 as rate_limit and 529 as transient', async () => {
    const make = (status: number, body: unknown) =>
      new ClaudeSubscriptionObservationProvider({
        oauthToken: 'sk-ant-oat01-abc',
        fetchImpl: (async () => jsonResponse(body, status)) as unknown as typeof fetch,
      });
    let k429 = ''; try { await make(429, { error: { message: 'rate' } }).generate(makeContext()); } catch (e: any) { k429 = e.kind; }
    let k529 = ''; try { await make(529, { error: { message: 'overloaded' } }).generate(makeContext()); } catch (e: any) { k529 = e.kind; }
    expect(k429).toBe('rate_limit');
    expect(k529).toBe('transient');
  });
});
