import { describe, it, expect, mock, spyOn } from 'bun:test';
import { Server } from '../../../src/services/server/Server.js';
import { ServerEnrollRoutes, type IssueEnrollmentKey } from '../../../src/server/routes/v1/ServerEnrollRoutes.js';
import { decodeEnrollment, requestSelfEnrollment, defaultEnrollLabel } from '../../../src/services/hooks/enrollment.js';
import { logger } from '../../../src/utils/logger.js';

async function startEnrollServer(secret: string | null, issueKey: IssueEnrollmentKey) {
  const spies = [spyOn(logger, 'info').mockImplementation(() => {}), spyOn(logger, 'error').mockImplementation(() => {})];
  const server = new Server({
    getInitializationComplete: () => true,
    getMcpReady: () => true,
    onShutdown: mock(() => Promise.resolve()),
    onRestart: mock(() => Promise.resolve()),
    workerPath: '/test/worker.cjs',
    runtime: 'server-beta',
    getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
  });
  server.registerRoutes(new ServerEnrollRoutes({ pool: {} as never, secret, issueKey }));
  server.finalizeRoutes();
  await server.listen(0, '127.0.0.1');
  const address = server.getHttpServer()?.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      try {
        await server.close();
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
      } finally {
        spies.forEach(s => s.mockRestore());
      }
    },
  };
}

function post(baseUrl: string, secret: string | null, body: unknown) {
  return fetch(`${baseUrl}/v1/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/enroll', () => {
  it('returns 404 when no join secret is configured', async () => {
    const issued: string[] = [];
    const h = await startEnrollServer(null, async ({ label }) => { issued.push(label); return { rawKey: 'k' }; });
    try {
      expect((await post(h.baseUrl, 'anything', { label: 'a' })).status).toBe(404);
      expect(issued).toEqual([]);
    } finally { await h.close(); }
  });

  it('rejects a wrong or missing secret with 401 and issues nothing', async () => {
    const issued: string[] = [];
    const h = await startEnrollServer('s3cret', async ({ label }) => { issued.push(label); return { rawKey: 'k' }; });
    try {
      expect((await post(h.baseUrl, 'wrong', { label: 'a' })).status).toBe(401);
      expect((await post(h.baseUrl, null, { label: 'a' })).status).toBe(401);
      expect(issued).toEqual([]);
    } finally { await h.close(); }
  });

  it('rejects an invalid label with 400', async () => {
    const h = await startEnrollServer('s3cret', async () => ({ rawKey: 'k' }));
    try {
      expect((await post(h.baseUrl, 's3cret', { label: '-bad label' })).status).toBe(400);
      expect((await post(h.baseUrl, 's3cret', {})).status).toBe(400);
    } finally { await h.close(); }
  });

  it('issues a key for the label and requestSelfEnrollment turns it into a client token', async () => {
    const issued: string[] = [];
    const h = await startEnrollServer('s3cret', async ({ label }) => { issued.push(label); return { rawKey: 'cmem_device' }; });
    try {
      const token = await requestSelfEnrollment({ serverUrl: `${h.baseUrl}/`, secret: 's3cret', label: 'bj@laptop' });
      expect(issued).toEqual(['bj@laptop']);
      expect(decodeEnrollment(token)).toEqual({ url: h.baseUrl, key: 'cmem_device' });
      await expect(requestSelfEnrollment({ serverUrl: h.baseUrl, secret: 'nope', label: 'x' })).rejects.toThrow('HTTP 401');
    } finally { await h.close(); }
  });
});

describe('defaultEnrollLabel', () => {
  it('builds user@host and strips characters the server rejects', () => {
    expect(defaultEnrollLabel('bj', 'arch-box.local')).toBe('bj@arch-box.local');
    expect(defaultEnrollLabel('John Doe', 'DESKTOP 1')).toBe('John-Doe@DESKTOP-1');
    expect(defaultEnrollLabel('', '')).toBe('client');
  });
});
