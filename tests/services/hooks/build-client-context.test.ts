// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { buildClientContext } from '../../../src/services/hooks/runtime-selector.js';
import { ServerBetaClient } from '../../../src/services/hooks/server-beta-client.js';

describe('buildClientContext', () => {
  function stubCtx(projectId: string | null) {
    return {
      runtime: 'client' as const,
      client: new ServerBetaClient({ serverBaseUrl: 'http://h:1', apiKey: 'k' }),
      projectId,
      serverBaseUrl: 'http://h:1',
    };
  }

  it('assembles writer, spool, and resolver from a client context', () => {
    const cc = buildClientContext(stubCtx(null));
    expect(cc.writer).toBeDefined();
    expect(cc.spool).toBeDefined();
    expect(cc.resolver).toBeDefined();
    expect(cc.client).toBeDefined();
    expect(cc.fixedProjectId).toBeNull();
  });

  it('passes a fixed project id through when present', () => {
    const cc = buildClientContext(stubCtx('fixed-uuid'));
    expect(cc.fixedProjectId).toBe('fixed-uuid');
  });

  it('also accepts a server-beta context (single-pool reuse)', () => {
    const cc = buildClientContext({
      runtime: 'server-beta', client: new ServerBetaClient({ serverBaseUrl: 'http://h:1', apiKey: 'k' }),
      projectId: 'sb-uuid', serverBaseUrl: 'http://h:1',
    });
    expect(cc.fixedProjectId).toBe('sb-uuid');
  });
});
