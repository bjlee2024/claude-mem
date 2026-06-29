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
import * as realShouldTrack from '../../../src/shared/should-track-project.js';
import * as realSpoolFlush from '../../../src/services/hooks/spool-flush.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };
const realShouldTrackSnapshot = { ...realShouldTrack };
const realSpoolFlushSnapshot = { ...realSpoolFlush };

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
}));

// The worker path MUST NOT be reached in client runtime.
const workerCallLog: Array<{ path: string; options: any }> = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
  workerHttpRequest: (apiPath: string, options?: any) => {
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
}));

// Always track the test project so the handler does not short-circuit on exclusion.
mock.module('../../../src/shared/should-track-project.js', () => ({
  shouldTrackProject: () => true,
}));

// --- runtime-selector mock --------------------------------------------------
// resolveRuntimeContext() returns a 'client' context; buildClientContext()
// returns controllable stubs. recordToolUse / flush are spies. Preserve all
// other real exports via the snapshot.
let recordToolUseCalls: Array<any> = [];
let flushCalls: Array<any> = [];
let flushImpl: (sender: unknown) => Promise<void> = async () => {};

const writerStub = {
  recordToolUse: (input: unknown) => {
    recordToolUseCalls.push(input);
    return Promise.resolve();
  },
};
const spoolStub = {
  flush: (sender: unknown) => {
    flushCalls.push(sender);
    return flushImpl(sender);
  },
};
const clientStub = {
  __isClientStub: true,
  forwardLogs: (_lines: string[]) => Promise.resolve(),
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
    resolver: { resolve: () => Promise.resolve('proj-id') },
    spool: spoolStub,
    writer: writerStub,
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
  logger.drainForwardBuffer(); // clear any cross-test contamination from other test files
  workerCallLog.length = 0;
  recordToolUseCalls = [];
  flushCalls = [];
  flushImpl = async () => {};
  madeSenderClient = null;
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
  mock.module('../../../src/shared/should-track-project.js', () => realShouldTrackSnapshot);
  mock.module('../../../src/services/hooks/spool-flush.js', () => realSpoolFlushSnapshot);
});

function clientInput() {
  return {
    sessionId: 'session-client-1',
    cwd: '/tmp/test-repo',
    platform: 'claude-code',
    toolName: 'Read',
    toolInput: { file_path: '/tmp/test-repo/x.ts' },
    toolResponse: { ok: true },
    agentId: undefined,
    agentType: undefined,
  };
}

describe('observationHandler — client runtime branch', () => {
  it('routes through ClientWriter and flushes the spool, returning SUCCESS', async () => {
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');

    const result = await observationHandler.execute(clientInput());

    // flush is pumped once (backlog drain)
    expect(flushCalls.length).toBe(1);
    // sender was built from the runtime client
    expect(madeSenderClient).toBe(clientStub);

    // recordToolUse called exactly once with the right shape
    expect(recordToolUseCalls.length).toBe(1);
    const call = recordToolUseCalls[0];
    expect(call.cwd).toBe('/tmp/test-repo');
    expect(call.sessionId).toBe('session-client-1');
    expect(typeof call.sourceEventId).toBe('string');
    expect(call.sourceEventId.length).toBeGreaterThan(0);
    expect(call.payload).toBeDefined();
    expect(call.payload.tool_name).toBe('Read');
    expect(call.payload.tool_input).toEqual({ file_path: '/tmp/test-repo/x.ts' });
    expect(call.payload.tool_response).toEqual({ ok: true });
    expect(call.payload.cwd).toBe('/tmp/test-repo');

    // never touches the worker path
    expect(workerCallLog.length).toBe(0);

    // returns the documented success result
    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
    expect(HOOK_EXIT_CODES.SUCCESS).toBe(0);
  });

  it('still returns continue:true even if spool.flush rejects (flush is best-effort)', async () => {
    flushImpl = async () => {
      throw new Error('flush boom');
    };
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');

    const result = await observationHandler.execute(clientInput());

    expect(flushCalls.length).toBe(1);
    // a failed flush must not block the write
    expect(recordToolUseCalls.length).toBe(1);
    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
    expect(workerCallLog.length).toBe(0);
  });
});
