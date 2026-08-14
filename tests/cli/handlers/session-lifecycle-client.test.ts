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

// stripMemoryTagsFromPrompt is left as the REAL implementation (not stubbed
// to identity) so the F2 private-tag-stripping tests below exercise actual
// behavior, not a pass-through.
mock.module('../../../src/utils/tag-stripping.js', () => ({
  ...realTagStrippingSnapshot,
  isInternalProtocolPayload: () => false,
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

// Captures direct client.recordEvent calls (the user_prompt event path added
// by session-init). Distinct from writerRecordEventCalls above, which
// captures the ClientWriter-routed path used by summarize.ts.
let recordEventCalls: Array<Record<string, unknown>> = [];
let recordEventImpl: (input: Record<string, unknown>) => Promise<unknown> = async () => ({});

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
  recordEvent: (input: Record<string, unknown>) => {
    recordEventCalls.push(input);
    return recordEventImpl(input);
  },
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
  logger.drainForwardBuffer(); // clear any cross-test contamination from other test files
  workerCallLog.length = 0;
  startSessionCalls = [];
  startSessionImpl = async () => ({ session: { id: 'server-sess-1' } });
  endSessionCalls = [];
  endSessionImpl = async () => ({});
  flushCalls = [];
  flushImpl = async () => {};
  writerRecordEventCalls = [];
  writerRecordEventImpl = async () => {};
  recordEventCalls = [];
  recordEventImpl = async () => ({});
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

  it('중단된 세션에서도 session-init은 평소대로 동작한다', async () => {
    const { pauseSession, resumeSession } = await import('../../../src/shared/session-pause.js');
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    pauseSession('session-init-client-1');
    try {
      // Same assertions the file's existing happy-path test makes — session-init
      // must behave identically whether or not recording is paused. This
      // asymmetry is the whole point of the feature.
      const result = await sessionInitHandler.execute(initInput());
      expect(result.continue).toBe(true);
    } finally {
      resumeSession('session-init-client-1');
    }
  });

  it('세션 시작 후 user_prompt 이벤트를 generate:false로 보낸다', async () => {
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    await sessionInitHandler.execute(initInput());

    const promptEvents = recordEventCalls.filter(c => c.eventType === 'user_prompt');
    expect(promptEvents.length).toBe(1);
    expect(promptEvents[0].payload).toEqual({ prompt: 'Hello, do something' });
    // generate:false is what keeps a prompt from spawning an LLM job. Its
    // absence costs money silently, so pin it.
    expect(promptEvents[0].generate).toBe(false);
  });

  it('일시 중지된 세션에서는 프롬프트 이벤트를 보내지 않는다', async () => {
    const { pauseSession, resumeSession } = await import('../../../src/shared/session-pause.js');
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    pauseSession('session-init-client-1');
    try {
      await sessionInitHandler.execute(initInput());

      expect(recordEventCalls.filter(c => c.eventType === 'user_prompt').length).toBe(0);
      // The asymmetry is the feature: the session still gets created, so later
      // events can attach to it, and context injection is untouched.
      expect(startSessionCalls.length).toBe(1);
    } finally {
      resumeSession('session-init-client-1');
    }
  });

  it('<private> 태그로 감싼 부분은 이벤트 payload에 도달하기 전에 제거된다 (F2)', async () => {
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    await sessionInitHandler.execute({
      ...initInput(),
      prompt: 'rotate this key <private>AKIA1234567890EXAMPLE</private> please',
    });

    const promptEvents = recordEventCalls.filter(c => c.eventType === 'user_prompt');
    expect(promptEvents.length).toBe(1);
    const payload = promptEvents[0].payload as { prompt: string };
    expect(payload.prompt).not.toContain('AKIA1234567890EXAMPLE');
    expect(payload.prompt).not.toContain('<private>');
    expect(payload.prompt).toBe('rotate this key  please');
  });

  it('프롬프트 전체가 private이면 user_prompt 이벤트를 아예 보내지 않는다 (F2)', async () => {
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    const result = await sessionInitHandler.execute({
      ...initInput(),
      prompt: '<private>AKIA1234567890EXAMPLE rotate this</private>',
    });

    expect(recordEventCalls.filter(c => c.eventType === 'user_prompt').length).toBe(0);
    // Session creation is still unconditional even when the whole prompt is private.
    expect(startSessionCalls.length).toBe(1);
    expect(result.continue).toBe(true);
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
