// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { startV1Server, type V1ServerContext } from './runtime/_v1-harness.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('POST /v1/projects/rename', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let ctx: V1ServerContext;

  beforeEach(async () => {
    ctx = await startV1Server();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('returns renamed:true when renaming an existing project (200)', async () => {
    const resp = await ctx.authedPost('/v1/projects/rename', {
      from: 'harness-project',
      to: 'renamed-project',
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.renamed).toBe(true);
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.name).toBe('renamed-project');
    expect(typeof body.merged).toBe('boolean');
  });

  it('returns 401 when no auth header is provided', async () => {
    const resp = await fetch(`http://127.0.0.1:${ctx.port}/v1/projects/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'harness-project', to: 'x' }),
    });
    expect(resp.status).toBe(401);
  });
});
