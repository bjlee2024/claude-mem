// Blocker 1 coverage (final pre-merge review, F1 re-review): a paused turn on
// the worker (default) runtime must not write a user_prompts row, must not
// broadcast over SSE, must not sync to Chroma, and must not start the
// observation generator — while sessionDbId/promptNumber and session creation
// keep working normally. This exercises the REAL route handler
// (SessionRoutes.handleSessionInitByClaudeId) against a real in-memory
// SessionStore, the same way the re-review that found the bug did, rather
// than mocking the store.
import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { ClaudeProvider } from '../../src/services/worker/ClaudeProvider.js';
import type { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import type { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import type { SessionEventBroadcaster } from '../../src/services/worker/events/SessionEventBroadcaster.js';
import type { WorkerService } from '../../src/services/worker-service.js';
import type { SessionCompletionHandler } from '../../src/services/worker/session/SessionCompletionHandler.js';

const dirs: string[] = [];
function tmpDb(): Database {
  const d = mkdtempSync(join(tmpdir(), 'sipr-'));
  dirs.push(d);
  const db = new Database(join(d, 'test.db'));
  new MigrationRunner(db).runAllMigrations();
  return db;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

interface Harness {
  routes: SessionRoutes;
  store: SessionStore;
  newPromptBroadcasts: unknown[];
  sessionStartedBroadcasts: Array<{ sessionDbId: number; project: string }>;
  chromaSyncCalls: unknown[][];
  generatorSpy: ReturnType<typeof spyOn>;
}

function buildHarness(): Harness {
  const db = tmpDb();
  const store = new SessionStore(db);

  const chromaSyncCalls: unknown[][] = [];
  const dbManager = {
    getSessionStore: () => store,
    getSessionById: (id: number) => {
      const session = store.getSessionById(id);
      if (!session) throw new Error(`Session ${id} not found`);
      return session;
    },
    getChromaSync: () => ({
      syncUserPrompt: (...args: unknown[]) => {
        chromaSyncCalls.push(args);
        return Promise.resolve();
      },
    }),
  } as unknown as DatabaseManager;

  const sessionManager = new SessionManager(dbManager);

  const newPromptBroadcasts: unknown[] = [];
  const sessionStartedBroadcasts: Array<{ sessionDbId: number; project: string }> = [];
  const eventBroadcaster = {
    broadcastNewPrompt: (p: unknown) => newPromptBroadcasts.push(p),
    broadcastSessionStarted: (sessionDbId: number, project: string) => sessionStartedBroadcasts.push({ sessionDbId, project }),
    broadcastSummarizeQueued: () => {},
  } as unknown as SessionEventBroadcaster;

  const routes = new SessionRoutes(
    sessionManager,
    dbManager,
    {} as unknown as ClaudeProvider,
    {} as unknown as GeminiProvider,
    {} as unknown as OpenRouterProvider,
    eventBroadcaster,
    {} as unknown as WorkerService,
    {} as unknown as SessionCompletionHandler,
  );

  // ensureGeneratorRunning is what starts the SDK agent / queues LLM work.
  // Spying it out is the direct analogue of the client/server-beta runtimes'
  // `generate: false` — the test asserts whether it was CALLED, not what it
  // does internally.
  const generatorSpy = spyOn(routes, 'ensureGeneratorRunning').mockResolvedValue(undefined);

  return { routes, store, newPromptBroadcasts, sessionStartedBroadcasts, chromaSyncCalls, generatorSpy };
}

// wrapHandler (BaseRouteHandler.ts) discards the inner promise, so resolve
// when res.json() is actually invoked rather than relying on microtask
// timing after the (void-returning) call.
function callInit(routes: SessionRoutes, body: Record<string, unknown>): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve) => {
    const req = { body, path: '/api/sessions/init' } as any;
    const res: any = {
      statusCode: 200,
      status(code: number) { res.statusCode = code; return res; },
      json(payload: unknown) { resolve({ statusCode: res.statusCode, body: payload }); return res; },
    };
    (routes as unknown as { handleSessionInitByClaudeId: (req: unknown, res: unknown) => void })
      .handleSessionInitByClaudeId(req, res);
  });
}

function userPromptRows(db: Database, contentSessionId: string): Array<{ prompt_number: number; prompt_text: string }> {
  return db.query('SELECT prompt_number, prompt_text FROM user_prompts WHERE content_session_id = ? ORDER BY prompt_number')
    .all(contentSessionId) as Array<{ prompt_number: number; prompt_text: string }>;
}

describe('SessionRoutes.handleSessionInitByClaudeId — paused turn (worker runtime)', () => {
  it('writes no user_prompts row while still returning sessionDbId, and skips broadcast/Chroma/generator', async () => {
    const h = buildHarness();
    const contentSessionId = 'pause-route-paused-1';

    const result = await callInit(h.routes, {
      contentSessionId,
      project: 'acme/widget',
      platformSource: 'claude',
      gitUser: null,
      paused: true,
      // No `prompt` key — matches what the hook actually sends while paused.
    });

    const body = result.body as { sessionDbId: number; promptNumber: number; skipped: boolean };
    expect(typeof body.sessionDbId).toBe('number');
    expect(body.promptNumber).toBe(1);
    expect(body.skipped).toBe(false);

    expect(userPromptRows(h.store.db, contentSessionId)).toHaveLength(0);
    expect(h.store.getPromptNumberFromUserPrompts(contentSessionId)).toBe(0);

    expect(h.newPromptBroadcasts.length).toBe(0);
    expect(h.chromaSyncCalls.length).toBe(0);
    expect(h.generatorSpy).not.toHaveBeenCalled();
  });

  it('two consecutive paused turns do not inflate prompt_number (no phantom rows to count)', async () => {
    const h = buildHarness();
    const contentSessionId = 'pause-route-paused-2';

    const first = await callInit(h.routes, {
      contentSessionId, project: 'acme/widget', platformSource: 'claude', gitUser: null, paused: true,
    });
    const second = await callInit(h.routes, {
      contentSessionId, project: 'acme/widget', platformSource: 'claude', gitUser: null, paused: true,
    });

    expect((first.body as { promptNumber: number }).promptNumber).toBe(1);
    expect((second.body as { promptNumber: number }).promptNumber).toBe(1);
    expect(h.store.getPromptNumberFromUserPrompts(contentSessionId)).toBe(0);
    expect(h.generatorSpy).not.toHaveBeenCalled();
  });

  it('control: an unpaused media-only prompt still stores \'[media prompt]\' and runs the normal side effects', async () => {
    const h = buildHarness();
    const contentSessionId = 'pause-route-unpaused-media';

    const result = await callInit(h.routes, {
      contentSessionId,
      project: 'acme/widget',
      platformSource: 'claude',
      gitUser: null,
      paused: false,
      // No `prompt` key — a genuine media-only prompt, indistinguishable from
      // a paused turn's request shape except for the explicit `paused` flag.
    });

    const body = result.body as { sessionDbId: number; promptNumber: number; skipped: boolean };
    expect(body.skipped).toBe(false);
    expect(body.promptNumber).toBe(1);

    const rows = userPromptRows(h.store.db, contentSessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt_text).toBe('[media prompt]');

    // The control also checks we did NOT over-suppress: a real (unpaused)
    // turn still gets the full set of side effects.
    expect(h.newPromptBroadcasts.length).toBe(1);
    expect(h.chromaSyncCalls.length).toBe(1);
    expect(h.generatorSpy).toHaveBeenCalledTimes(1);
  });
});
