// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { startV1Server, type V1ServerContext } from './_v1-harness.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('/v1/context recent-mode', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let ctx: V1ServerContext;

  beforeEach(async () => {
    ctx = await startV1Server();

    // Seed 2 observations for the project, mirroring the viewer test INSERT style.
    for (let i = 0; i < 2; i++) {
      await ctx.client.query(
        `INSERT INTO observations (id, project_id, team_id, kind, content, metadata, created_at)
         VALUES ($1, $2, $3, 'observation', $4, $5, now() + ($6 || ' seconds')::interval)`,
        [
          crypto.randomUUID(),
          ctx.projectId,
          ctx.teamId,
          `Recent observation content ${i} with some meaningful text`,
          JSON.stringify({
            title: `obs${i}`,
            facts: [`fact${i}`],
            concepts: [],
            files_read: [],
            files_modified: [],
            provider: 'claude',
          }),
          String(i),
        ],
      );
    }
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('returns recent observations when query is empty (session-start mode)', async () => {
    const res = await ctx.authedPost('/v1/context', {
      projectId: ctx.projectId,
      query: '',
      limit: 10,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { observations: Array<{ content: string; createdAtEpoch: number }>; context: string };
    expect(Array.isArray(body.observations)).toBe(true);
    expect(body.observations.length).toBeGreaterThanOrEqual(1);
    expect(typeof body.context).toBe('string');
    expect(body.context.length).toBeGreaterThan(0);
    // Newest seed (i=1, created 1 s later) must appear first — verifies ORDER BY created_at DESC.
    expect(body.observations[0].content).toContain('content 1');
  });

  it('returns recent observations when query is whitespace-only (session-start mode)', async () => {
    const res = await ctx.authedPost('/v1/context', {
      projectId: ctx.projectId,
      query: '   ',
      limit: 10,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { observations: unknown[]; context: string };
    expect(Array.isArray(body.observations)).toBe(true);
    expect(body.observations.length).toBeGreaterThanOrEqual(1);
    expect(typeof body.context).toBe('string');
    expect(body.context.length).toBeGreaterThan(0);
  });

  it('returns recent observations when query is absent (session-start mode)', async () => {
    const res = await ctx.authedPost('/v1/context', {
      projectId: ctx.projectId,
      limit: 10,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { observations: unknown[]; context: string };
    expect(Array.isArray(body.observations)).toBe(true);
    expect(body.observations.length).toBeGreaterThanOrEqual(1);
    expect(typeof body.context).toBe('string');
    expect(body.context.length).toBeGreaterThan(0);
  });

  it('still searches when query is provided', async () => {
    const res = await ctx.authedPost('/v1/context', {
      projectId: ctx.projectId,
      query: 'Recent observation content',
      limit: 10,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { observations: unknown[]; context: string };
    // Shape must be intact regardless of FTS tokenisation behaviour
    expect(Array.isArray(body.observations)).toBe(true);
    expect(typeof body.context).toBe('string');
  });
});
