// F1 coverage: the default runtime (worker) branch of sessionInitHandler must
// suppress the real prompt text on /api/sessions/init while a session is
// paused, while still creating the session so sessionDbId/promptNumber and
// context injection keep working. See src/cli/handlers/session-init.ts.
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realShouldTrack from '../../../src/shared/should-track-project.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const realHookSettingsSnapshot = { ...realHookSettings };
const realShouldTrackSnapshot = { ...realShouldTrack };
const realProjectNameSnapshot = { ...realProjectName };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

// No CLAUDE_MEM_RUNTIME key => resolveRuntimeContext() defaults to 'worker'
// (see normalizeRuntimeValue in runtime-selector.ts). Semantic injection is
// off so the handler makes exactly one worker call (session init).
mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_SEMANTIC_INJECT: 'false',
  }),
}));

mock.module('../../../src/shared/should-track-project.js', () => ({
  shouldTrackProject: () => true,
}));

mock.module('../../../src/utils/project-name.js', () => ({
  ...realProjectNameSnapshot,
  getProjectContext: () => ({ primary: 'test-project', secondary: null }),
}));

let workerCalls: Array<{ path: string; method: string; body: unknown }> = [];
let initResponse: Record<string, unknown> = { sessionDbId: 42, promptNumber: 1, contextInjected: false };

mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
  workerHttpRequest: () => {
    throw new Error('workerHttpRequest MUST NOT be called directly in this test');
  },
  executeWithWorkerFallback: async (path: string, method: string, body?: unknown) => {
    workerCalls.push({ path, method, body });
    if (path === '/api/sessions/init') return initResponse;
    return {};
  },
  isWorkerFallback: () => false,
  fetchWithTimeout: () => {
    throw new Error('fetchWithTimeout MUST NOT be called in this test');
  },
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCalls = [];
  initResponse = { sessionDbId: 42, promptNumber: 1, contextInjected: false };
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
});

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/should-track-project.js', () => realShouldTrackSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('sessionInitHandler — worker (default) runtime branch', () => {
  function initInput(sessionId: string) {
    return {
      sessionId,
      cwd: '/tmp/test-repo',
      platform: 'claude-code' as const,
      prompt: 'my real secret prompt text',
      toolName: undefined,
      toolInput: undefined,
      toolResponse: undefined,
      agentId: undefined,
      agentType: undefined,
    };
  }

  it('sends the real prompt to /api/sessions/init when not paused', async () => {
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    const result = await sessionInitHandler.execute(initInput('session-init-worker-unpaused'));

    const initCall = workerCalls.find(c => c.path === '/api/sessions/init');
    expect(initCall).toBeDefined();
    const body = initCall!.body as Record<string, unknown>;
    expect(body.prompt).toBe('my real secret prompt text');
    expect(result.continue).toBe(true);
  });

  it('does not send the real prompt while paused, but still initializes the session', async () => {
    const { pauseSession, resumeSession } = await import('../../../src/shared/session-pause.js');
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    const sessionId = 'session-init-worker-paused';
    pauseSession(sessionId);
    try {
      const result = await sessionInitHandler.execute(initInput(sessionId));

      const initCall = workerCalls.find(c => c.path === '/api/sessions/init');
      expect(initCall).toBeDefined();
      const body = initCall!.body as Record<string, unknown>;
      // The real prompt text must never be put on the wire while paused.
      expect(body.prompt).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('my real secret prompt text');

      // Control: session creation is unconditional. The handler still reads
      // sessionDbId/promptNumber back from the (mocked) response, proving the
      // request was made and processed normally rather than skipped.
      expect(result.continue).toBe(true);
      expect(result.suppressOutput).toBe(true);
    } finally {
      resumeSession(sessionId);
    }
  });
});
