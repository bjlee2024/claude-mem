// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { startV1Server, type V1ServerContext } from './_v1-harness.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('/v1/timeline', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let ctx: V1ServerContext;

  beforeEach(async () => {
    ctx = await startV1Server();

    // Seed 3 observations + 1 summary, staggered in time.
    for (let i = 0; i < 3; i++) {
      await ctx.client.query(
        `INSERT INTO observations (id, project_id, team_id, kind, content, metadata, created_at)
         VALUES ($1, $2, $3, 'observation', $4, $5, now() + ($6 || ' seconds')::interval)`,
        [
          crypto.randomUUID(),
          ctx.projectId,
          ctx.teamId,
          `Timeline observation ${i}`,
          JSON.stringify({ title: `obs${i}`, facts: [], concepts: [], files_read: [], files_modified: [] }),
          String(i),
        ],
      );
    }
    await ctx.client.query(
      `INSERT INTO observations (id, project_id, team_id, kind, content, metadata, created_at)
       VALUES ($1, $2, $3, 'summary', $4, $5, now() + '10 seconds'::interval)`,
      [
        crypto.randomUUID(),
        ctx.projectId,
        ctx.teamId,
        'session summary content',
        JSON.stringify({ investigated: 'x', learned: 'y', completed: 'z', next_steps: 'w' }),
      ],
    );
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('returns all observations including kind=summary', async () => {
    const res = await ctx.authedPost('/v1/timeline', { projectId: ctx.projectId, limit: 500 });
    expect(res.status).toBe(200);
    const body = await res.json() as { observations: Array<{ kind: string }>; hasMore: boolean };
    expect(Array.isArray(body.observations)).toBe(true);
    expect(body.observations.length).toBe(4); // 3 observations + 1 summary
    expect(body.observations.some(o => o.kind === 'summary')).toBe(true);
    expect(body.hasMore).toBe(false);
  });

  it('paginates via limit + offset and signals hasMore', async () => {
    const page1 = await ctx.authedPost('/v1/timeline', { projectId: ctx.projectId, limit: 2, offset: 0 });
    const b1 = await page1.json() as { observations: unknown[]; hasMore: boolean };
    expect(b1.observations.length).toBe(2);
    expect(b1.hasMore).toBe(true);

    const page2 = await ctx.authedPost('/v1/timeline', { projectId: ctx.projectId, limit: 2, offset: 2 });
    const b2 = await page2.json() as { observations: unknown[]; hasMore: boolean };
    expect(b2.observations.length).toBe(2);
    // 4 total, page2 returns exactly the limit, so hasMore is true (caller stops when a short/empty page returns)
    expect(b2.hasMore).toBe(true);

    const page3 = await ctx.authedPost('/v1/timeline', { projectId: ctx.projectId, limit: 2, offset: 4 });
    const b3 = await page3.json() as { observations: unknown[]; hasMore: boolean };
    expect(b3.observations.length).toBe(0);
    expect(b3.hasMore).toBe(false);
  });
});
