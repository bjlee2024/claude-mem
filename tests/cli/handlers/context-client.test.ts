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

// ModeManager must be mocked before ContextBuilder is imported (via context.ts),
// because loadContextConfig() calls ModeManager.getInstance().getActiveMode() and
// throws if no mode is loaded.
mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [
          { id: 'observation', emoji: 'O' },
          { id: 'decision', emoji: 'D' },
          { id: 'bugfix', emoji: 'B' },
        ],
        observation_concepts: [{ id: 'general', emoji: 'G' }],
      }),
      getTypeIcon: (type: string) => {
        const icons: Record<string, string> = { observation: 'O', decision: 'D', bugfix: 'B' };
        return icons[type] || '?';
      },
      getWorkEmoji: () => 'W',
    }),
  },
}));

// Mutable context settings so individual tests can flip flags like
// CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY. Reset in beforeEach.
const baseContextSettings: Record<string, string> = {
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
  CLAUDE_MEM_CONTEXT_FULL_COUNT: '0',
  CLAUDE_MEM_CONTEXT_SESSION_COUNT: '10',
  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'false',
  CLAUDE_MEM_CONTEXT_FULL_FIELD: 'narrative',
  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false',
  CLAUDE_MEM_MODE: 'code',
};
let contextSettings: Record<string, string> = { ...baseContextSettings };

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ ...contextSettings }),
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
  logger.drainForwardBuffer(); // clear any cross-test contamination from other test files
  workerCallLog.length = 0;
  contextObservationsCalls = [];
  flushCalls = [];
  flushImpl = async () => {};
  madeSenderClient = null;
  contextObservationsImpl = async () => ({ observations: [], context: '' });
  contextSettings = { ...baseContextSettings };
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
  it('renders formatted context from observations (not raw context string)', async () => {
    // Provide a real observation so the renderer produces structured output.
    contextObservationsImpl = async () => ({
      observations: [
        {
          id: 'mig-obs-153',
          projectId: 'proj-id',
          teamId: 'team-1',
          serverSessionId: 'sess-abc',
          kind: 'observation',
          content: 'remembered: X',
          metadata: {
            type: 'observation',
            title: 'Test Observation',
            subtitle: 'a subtitle',
            narrative: 'remembered: X',
            facts: null,
            concepts: null,
            created_at: '2025-01-15T10:00:00.000Z',
          },
        },
      ],
      context: 'remembered: X',
    });

    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute(sessionStartInput());

    // additionalContext must be the FORMATTED output, not the raw context string.
    expect(result.hookSpecificOutput).toBeDefined();
    const additionalContext = (result.hookSpecificOutput as { hookEventName: string; additionalContext: string }).additionalContext;
    // Must contain formatted title, not the raw "remembered: X" context dump.
    expect(additionalContext).toContain('Test Observation');
    // Must NOT contain raw claude-mem:// markers.
    expect(additionalContext).not.toContain('claude-mem://');
    // Must not be the literal context string.
    expect(additionalContext).not.toBe('remembered: X');

    // spool was flushed exactly once (best-effort)
    expect(flushCalls.length).toBe(1);

    // worker path was never taken
    expect(workerCallLog.length).toBe(0);

    // exit code is SUCCESS
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
  });

  it('returns empty additionalContext when observations array is empty', async () => {
    contextObservationsImpl = async () => ({
      observations: [],
      context: 'remembered: X',
    });

    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute(sessionStartInput());

    expect(result.hookSpecificOutput).toBeDefined();
    const additionalContext = (result.hookSpecificOutput as { hookEventName: string; additionalContext: string }).additionalContext;
    // Empty observations → renderer returns '' → additionalContext is ''.
    expect(additionalContext).toBe('');

    // spool was flushed exactly once (best-effort)
    expect(flushCalls.length).toBe(1);

    // worker path was never taken
    expect(workerCallLog.length).toBe(0);

    // exit code is SUCCESS
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
  });

  it('renders the session summary panel from a kind=summary observation', async () => {
    contextSettings.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY = 'true';
    const obsEpoch = Date.parse('2026-06-05T09:00:00.000Z');
    const summaryEpoch = Date.parse('2026-06-05T10:00:00.000Z'); // newer than obs

    contextObservationsImpl = async () => ({
      observations: [
        {
          id: 'sum-1',
          projectId: 'proj-id',
          teamId: 'team-1',
          serverSessionId: 'sess-sum',
          kind: 'summary',
          content: 'rendered summary text',
          createdAtEpoch: summaryEpoch,
          metadata: {
            type: 'summary',
            request: 'Fix the startup summary',
            investigated: 'Traced the client context path',
            learned: 'Summaries were hardcoded to empty',
            completed: 'Mapped summary rows',
            next_steps: 'Ship it',
          },
        },
        {
          id: 'obs-1',
          projectId: 'proj-id',
          teamId: 'team-1',
          serverSessionId: 'sess-abc',
          kind: 'observation',
          content: 'did work',
          createdAtEpoch: obsEpoch,
          metadata: { type: 'observation', title: 'Did work', narrative: 'did work' },
        },
      ],
      context: 'rendered summary text',
    });

    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute(sessionStartInput());
    const additionalContext = (result.hookSpecificOutput as { additionalContext: string }).additionalContext;

    // Summary panel fields render (agent format: **Label**: value)
    expect(additionalContext).toContain('**Investigated**: Traced the client context path');
    expect(additionalContext).toContain('**Learned**: Summaries were hardcoded to empty');
    expect(additionalContext).toContain('**Completed**: Mapped summary rows');
    expect(additionalContext).toContain('**Next Steps**: Ship it');
    // Regular observation still shows in the timeline.
    expect(additionalContext).toContain('Did work');
    // Timestamp must NOT be the 1970 epoch-0 fallback.
    expect(additionalContext).not.toContain('1970');
    expect(workerCallLog.length).toBe(0);
  });

  it('maps createdAtEpoch so observations are not dated 1970', async () => {
    const obsEpoch = Date.parse('2026-06-05T09:00:00.000Z');
    contextObservationsImpl = async () => ({
      observations: [
        {
          id: 'obs-ts',
          projectId: 'proj-id',
          teamId: 'team-1',
          serverSessionId: 'sess-ts',
          kind: 'observation',
          content: 'work',
          createdAtEpoch: obsEpoch,
          metadata: { type: 'observation', title: 'Timestamped Work', narrative: 'work' },
        },
      ],
      context: 'work',
    });

    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute(sessionStartInput());
    const additionalContext = (result.hookSpecificOutput as { additionalContext: string }).additionalContext;

    expect(additionalContext).toContain('Timestamped Work');
    expect(additionalContext).not.toContain('1970');
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
