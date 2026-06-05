import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
import * as realSpoolFlush from '../../../src/services/hooks/spool-flush.js';
import * as realOauthToken from '../../../src/shared/oauth-token.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };
const realSpoolFlushSnapshot = { ...realSpoolFlush };
const realOauthTokenSnapshot = { ...realOauthToken };

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({}),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({}),
}));

// The worker path MUST NOT be reached in client runtime.
const workerCallLog: Array<{ path: string; options: unknown }> = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
  workerHttpRequest: (apiPath: string, options?: unknown) => {
    workerCallLog.push({ path: apiPath, options });
    throw new Error(
      `workerHttpRequest MUST NOT be called in client context (called with ${apiPath})`
    );
  },
  executeWithWorkerFallback: (apiPath: string, _method?: string, _body?: unknown) => {
    workerCallLog.push({ path: apiPath, options: _body });
    throw new Error(
      `executeWithWorkerFallback MUST NOT be called in client context (called with ${apiPath})`
    );
  },
  isWorkerFallback: () => false,
  fetchWithTimeout: () => {
    throw new Error('fetchWithTimeout MUST NOT be called in client context');
  },
}));

// Suppress stale OAuth marker so it does not interfere with context string assertions.
mock.module('../../../src/shared/oauth-token.js', () => ({
  ...realOauthTokenSnapshot,
  readStaleMarker: () => null,
}));

// --- per-test controllable stubs ---
let contextObservationsCalls: Array<unknown> = [];
let contextObservationsImpl: () => Promise<{ observations: unknown[]; context: string }> =
  async () => ({ observations: [], context: '' });

let flushCalls: Array<unknown> = [];
let flushImpl: (sender: unknown) => Promise<void> = async () => {};

const spoolStub = {
  flush: (sender: unknown) => {
    flushCalls.push(sender);
    return flushImpl(sender);
  },
};

const clientStub = {
  __isClientStub: true,
  contextObservations: (input: unknown) => {
    contextObservationsCalls.push(input);
    return contextObservationsImpl();
  },
};

const clientRuntimeContext = {
  runtime: 'client' as const,
  client: clientStub,
  projectId: null,
  serverBaseUrl: 'http://localhost:9999',
};

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  ...realRuntimeSelectorSnapshot,
  resolveRuntimeContext: () => clientRuntimeContext,
  buildClientContext: (_ctx: unknown) => ({
    client: clientStub,
    resolver: { resolve: async () => 'proj-id' },
    spool: spoolStub,
    writer: {},
    fixedProjectId: null,
  }),
}));

// makeSpoolSender is imported by the handler; keep it from doing real IO.
let madeSenderClient: unknown = null;
mock.module('../../../src/services/hooks/spool-flush.js', () => ({
  ...realSpoolFlushSnapshot,
  makeSpoolSender: (deps: { client: unknown }) => {
    madeSenderClient = deps.client;
    return async () => ({ ok: true });
  },
}));

import { logger } from '../../../src/utils/logger.js';
import { HOOK_EXIT_CODES } from '../../../src/shared/hook-constants.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCallLog.length = 0;
  contextObservationsCalls = [];
  flushCalls = [];
  flushImpl = async () => {};
  madeSenderClient = null;
  contextObservationsImpl = async () => ({ observations: [], context: '' });
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
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
  mock.module('../../../src/services/hooks/spool-flush.js', () => realSpoolFlushSnapshot);
  mock.module('../../../src/shared/oauth-token.js', () => realOauthTokenSnapshot);
});

function sessionStartInput() {
  return {
    sessionId: 'session-ctx-client-1',
    cwd: '/tmp/test-repo',
    platform: 'claude-code' as const,
    toolName: undefined,
    toolInput: undefined,
    toolResponse: undefined,
    agentId: undefined,
    agentType: undefined,
  };
}

describe('contextHandler — client runtime branch', () => {
  it('injects remote context string', async () => {
    contextObservationsImpl = async () => ({
      observations: [],
      context: 'remembered: X',
    });

    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute(sessionStartInput());

    // additionalContext comes from the server response
    expect(result.hookSpecificOutput).toBeDefined();
    expect((result.hookSpecificOutput as { hookEventName: string; additionalContext: string }).additionalContext).toBe('remembered: X');

    // spool was flushed exactly once (best-effort)
    expect(flushCalls.length).toBe(1);

    // worker path was never taken
    expect(workerCallLog.length).toBe(0);

    // exit code is SUCCESS
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
  });

  it('offline returns empty context, never throws', async () => {
    contextObservationsImpl = async () => {
      throw new Error('ECONNREFUSED');
    };

    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    let result: Awaited<ReturnType<typeof contextHandler.execute>>;
    let threw = false;
    try {
      result = await contextHandler.execute(sessionStartInput());
    } catch {
      threw = true;
      result = undefined as unknown as typeof result;
    }

    expect(threw).toBe(false);
    expect((result!.hookSpecificOutput as { hookEventName: string; additionalContext: string }).additionalContext).toBe('');
    expect(result!.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);

    // worker path was never taken
    expect(workerCallLog.length).toBe(0);
  });
});
