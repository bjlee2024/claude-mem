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
import * as realTagStripping from '../../../src/utils/tag-stripping.js';
import * as realPlatformSource from '../../../src/shared/platform-source.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realTranscriptParser from '../../../src/shared/transcript-parser.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };
const realShouldTrackSnapshot = { ...realShouldTrack };
const realSpoolFlushSnapshot = { ...realSpoolFlush };
const realTagStrippingSnapshot = { ...realTagStripping };
const realPlatformSourceSnapshot = { ...realPlatformSource };
const realProjectNameSnapshot = { ...realProjectName };
const realTranscriptParserSnapshot = { ...realTranscriptParser };

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
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_SEMANTIC_INJECT: 'false',
  }),
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

// Always track the test project so the handler does not short-circuit on exclusion.
mock.module('../../../src/shared/should-track-project.js', () => ({
  shouldTrackProject: () => true,
}));

mock.module('../../../src/utils/tag-stripping.js', () => ({
  ...realTagStrippingSnapshot,
  isInternalProtocolPayload: () => false,
  stripMemoryTagsFromPrompt: (s: string) => s,
}));

mock.module('../../../src/shared/platform-source.js', () => ({
  ...realPlatformSourceSnapshot,
  normalizePlatformSource: (p: unknown) => (p as string) ?? 'claude-code',
}));

mock.module('../../../src/utils/project-name.js', () => ({
  ...realProjectNameSnapshot,
  getProjectContext: () => ({ primary: 'test-project', secondary: null }),
}));

mock.module('../../../src/shared/transcript-parser.js', () => ({
  ...realTranscriptParserSnapshot,
  extractLastMessage: () => 'This is the last assistant message.',
}));

// --- per-test controllable stubs ---
let startSessionCalls: Array<unknown> = [];
let startSessionImpl: () => Promise<{ session: { id: string } }> =
  async () => ({ session: { id: 'server-sess-1' } });

let endSessionCalls: Array<unknown> = [];
let endSessionImpl: () => Promise<unknown> = async () => ({});

let flushCalls: Array<unknown> = [];
let flushImpl: (sender: unknown) => Promise<void> = async () => {};

let writerRecordEventCalls: Array<unknown> = [];
let writerRecordEventImpl: (input: unknown) => Promise<void> = async () => {};

const spoolStub = {
  flush: (sender: unknown) => {
    flushCalls.push(sender);
    return flushImpl(sender);
  },
};

const resolverStub = {
  resolve: async () => 'proj-id-resolved',
};

const writerStub = {
  recordEvent: (input: unknown) => {
    writerRecordEventCalls.push(input);
    return writerRecordEventImpl(input);
  },
};

const clientStub = {
  __isClientStub: true,
  startSession: (input: unknown) => {
    startSessionCalls.push(input);
    return startSessionImpl();
  },
  endSession: (input: unknown) => {
    endSessionCalls.push(input);
    return endSessionImpl();
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
    resolver: resolverStub,
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
  workerCallLog.length = 0;
  startSessionCalls = [];
  startSessionImpl = async () => ({ session: { id: 'server-sess-1' } });
  endSessionCalls = [];
  endSessionImpl = async () => ({});
  flushCalls = [];
  flushImpl = async () => {};
  writerRecordEventCalls = [];
  writerRecordEventImpl = async () => {};
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
  mock.module('../../../src/utils/tag-stripping.js', () => realTagStrippingSnapshot);
  mock.module('../../../src/shared/platform-source.js', () => realPlatformSourceSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/transcript-parser.js', () => realTranscriptParserSnapshot);
});

// ---------------------------------------------------------------------------
// sessionInitHandler — client branch
// ---------------------------------------------------------------------------
describe('sessionInitHandler — client runtime branch', () => {
  function initInput() {
    return {
      sessionId: 'session-init-client-1',
      cwd: '/tmp/test-repo',
      platform: 'claude-code' as const,
      prompt: 'Hello, do something',
      toolName: undefined,
      toolInput: undefined,
      toolResponse: undefined,
      agentId: undefined,
      agentType: undefined,
    };
  }

  it('calls startSession once, flushes spool, returns { continue: true, suppressOutput: true }', async () => {
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    const result = await sessionInitHandler.execute(initInput());

    // spool was flushed once (best-effort backlog drain)
    expect(flushCalls.length).toBe(1);
    // sender was built from the runtime client
    expect(madeSenderClient).toBe(clientStub);

    // startSession called exactly once
    expect(startSessionCalls.length).toBe(1);
    const call = startSessionCalls[0] as Record<string, unknown>;
    expect(call.projectId).toBe('proj-id-resolved');
    expect(call.externalSessionId).toBe('session-init-client-1');
    expect(call.contentSessionId).toBe('session-init-client-1');

    // worker path never reached
    expect(workerCallLog.length).toBe(0);

    // success shape mirrors the server-beta branch
    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
  });

  it('returns { continue: true } even when startSession rejects (best-effort)', async () => {
    startSessionImpl = async () => {
      throw new Error('network error');
    };
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    let threw = false;
    let result: Awaited<ReturnType<typeof sessionInitHandler.execute>> | undefined;
    try {
      result = await sessionInitHandler.execute(initInput());
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result!.continue).toBe(true);
    // worker path never reached
    expect(workerCallLog.length).toBe(0);
  });

  it('returns { continue: true } even when spool.flush rejects (flush is best-effort)', async () => {
    flushImpl = async () => {
      throw new Error('flush boom');
    };
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    let threw = false;
    let result: Awaited<ReturnType<typeof sessionInitHandler.execute>> | undefined;
    try {
      result = await sessionInitHandler.execute(initInput());
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result!.continue).toBe(true);
    expect(workerCallLog.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// summarizeHandler — client branch
// ---------------------------------------------------------------------------
describe('summarizeHandler — client runtime branch', () => {
  function summarizeInput() {
    return {
      sessionId: 'session-sum-client-1',
      cwd: '/tmp/test-repo',
      platform: 'claude-code' as const,
      // Provide lastAssistantMessage directly so no transcript IO is needed
      lastAssistantMessage: 'Here is what I did: found the bug.',
      toolName: undefined,
      toolInput: undefined,
      toolResponse: undefined,
      agentId: undefined,
      agentType: undefined,
      stopHookActive: false,
      transcriptPath: undefined,
    };
  }

  it('records assistant message via writer (durable), calls startSession then endSession, flushes spool, returns success', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    const result = await summarizeHandler.execute(summarizeInput());

    // spool was flushed once
    expect(flushCalls.length).toBe(1);
    // sender was built from the runtime client
    expect(madeSenderClient).toBe(clientStub);

    // writer.recordEvent called once with assistant_message eventType (durable path)
    expect(writerRecordEventCalls.length).toBe(1);
    const writeCall = writerRecordEventCalls[0] as Record<string, unknown>;
    expect(writeCall.eventType).toBe('assistant_message');
    expect((writeCall.payload as Record<string, unknown>).last_assistant_message).toBe('Here is what I did: found the bug.');

    // startSession called to resolve the server session ID (idempotent, lifecycle)
    expect(startSessionCalls.length).toBe(1);
    const startCall = startSessionCalls[0] as Record<string, unknown>;
    expect(startCall.externalSessionId).toBe('session-sum-client-1');
    expect(startCall.contentSessionId).toBe('session-sum-client-1');

    // endSession called exactly once with the server session id
    expect(endSessionCalls.length).toBe(1);
    const endCall = endSessionCalls[0] as Record<string, unknown>;
    expect(endCall.sessionId).toBe('server-sess-1');

    // worker path never reached
    expect(workerCallLog.length).toBe(0);

    // success shape mirrors the server-beta branch
    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
  });

  it('returns success even when endSession rejects (lifecycle is best-effort)', async () => {
    endSessionImpl = async () => {
      throw new Error('server down');
    };
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    let threw = false;
    let result: Awaited<ReturnType<typeof summarizeHandler.execute>> | undefined;
    try {
      result = await summarizeHandler.execute(summarizeInput());
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result!.continue).toBe(true);
    // writer still recorded the assistant message (durable, separate from lifecycle)
    expect(writerRecordEventCalls.length).toBe(1);
    expect(workerCallLog.length).toBe(0);
  });

  it('returns success even when startSession rejects — endSession NOT called, writer still records', async () => {
    startSessionImpl = async () => {
      throw new Error('startSession failed');
    };
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    let threw = false;
    let result: Awaited<ReturnType<typeof summarizeHandler.execute>> | undefined;
    try {
      result = await summarizeHandler.execute(summarizeInput());
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result!.continue).toBe(true);
    // endSession must NOT have been called (startSession failed, no serverSessionId)
    expect(endSessionCalls.length).toBe(0);
    // writer still recorded the assistant message (durable content path is separate)
    expect(writerRecordEventCalls.length).toBe(1);
    expect(workerCallLog.length).toBe(0);
  });

  it('returns { continue: true } even when spool.flush rejects (flush is best-effort)', async () => {
    flushImpl = async () => {
      throw new Error('flush boom');
    };
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    let threw = false;
    let result: Awaited<ReturnType<typeof summarizeHandler.execute>> | undefined;
    try {
      result = await summarizeHandler.execute(summarizeInput());
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result!.continue).toBe(true);
    expect(workerCallLog.length).toBe(0);
  });
});
