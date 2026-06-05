// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { startV1Server, type V1ServerContext } from './_v1-harness.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('POST /v1/projects/resolve', () => {
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

  it('creates then returns the same id for the same name (idempotent)', async () => {
    const resp1 = await ctx.authedPost('/v1/projects/resolve', { name: 'repo-a' });
    expect(resp1.status).toBe(200);
    const body1 = await resp1.json();
    expect(typeof body1.id).toBe('string');
    expect(body1.id.length).toBeGreaterThan(0);

    const resp2 = await ctx.authedPost('/v1/projects/resolve', { name: 'repo-a' });
    expect(resp2.status).toBe(200);
    const body2 = await resp2.json();
    expect(body2.id).toBe(body1.id);
  });

  it('rejects an empty name with 400', async () => {
    const resp = await ctx.authedPost('/v1/projects/resolve', { name: '' });
    expect(resp.status).toBe(400);
  });

  it('rejects a project-scoped key with 403', async () => {
    const projectKey = await ctx.createProjectScopedKey(ctx.projectId);
    const resp = await ctx.authedPost('/v1/projects/resolve', { name: 'whatever' }, projectKey);
    expect(resp.status).toBe(403);
  });
});
