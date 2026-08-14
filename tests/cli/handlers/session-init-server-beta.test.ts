// F1/F2 coverage for the server-beta branch of sessionInitHandler
// (src/cli/handlers/session-init.ts, runtime.runtime === 'server-beta'):
// - already-paused sessions must not emit a user_prompt event (F1, existing
//   behavior — asserted here as a control alongside the new F2 assertions)
// - <private> tags must be stripped from the event payload, and a wholly
//   private prompt must send no event at all (F2)
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';

import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
import * as realShouldTrack from '../../../src/shared/should-track-project.js';
import * as realPlatformSource from '../../../src/shared/platform-source.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';

const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };
const realShouldTrackSnapshot = { ...realShouldTrack };
const realPlatformSourceSnapshot = { ...realPlatformSource };
const realProjectNameSnapshot = { ...realProjectName };
const realHookSettingsSnapshot = { ...realHookSettings };

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_SEMANTIC_INJECT: 'false',
  }),
}));

mock.module('../../../src/shared/should-track-project.js', () => ({
  shouldTrackProject: () => true,
}));

mock.module('../../../src/shared/platform-source.js', () => ({
  ...realPlatformSourceSnapshot,
  normalizePlatformSource: (p: unknown) => (p as string) ?? 'claude-code',
}));

mock.module('../../../src/utils/project-name.js', () => ({
  ...realProjectNameSnapshot,
  getProjectContext: () => ({ primary: 'test-project', secondary: null }),
}));

// tag-stripping.js is intentionally left unmocked so F2 exercises the real
// stripMemoryTagsFromPrompt/isInternalProtocolPayload behavior.

let startSessionCalls: Array<unknown> = [];
let recordEventCalls: Array<Record<string, unknown>> = [];

const serverBetaClientStub = {
  __isServerBetaStub: true,
  startSession: (input: unknown) => {
    startSessionCalls.push(input);
    return Promise.resolve({ session: { id: 'server-beta-sess-1' } });
  },
  recordEvent: (input: Record<string, unknown>) => {
    recordEventCalls.push(input);
    return Promise.resolve({});
  },
};

const serverBetaRuntimeContext = {
  runtime: 'server-beta' as const,
  client: serverBetaClientStub,
  projectId: 'sb-project-1',
  serverBaseUrl: 'http://localhost:9999',
};

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  ...realRuntimeSelectorSnapshot,
  resolveRuntimeContext: () => serverBetaRuntimeContext,
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  startSessionCalls = [];
  recordEventCalls = [];
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
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
  mock.module('../../../src/shared/should-track-project.js', () => realShouldTrackSnapshot);
  mock.module('../../../src/shared/platform-source.js', () => realPlatformSourceSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
});

describe('sessionInitHandler — server-beta runtime branch', () => {
  function initInput(sessionId: string, prompt: string) {
    return {
      sessionId,
      cwd: '/tmp/test-repo',
      platform: 'claude-code' as const,
      prompt,
      toolName: undefined,
      toolInput: undefined,
      toolResponse: undefined,
      agentId: undefined,
      agentType: undefined,
    };
  }

  it('sends the raw prompt as a user_prompt event when nothing is private', async () => {
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    await sessionInitHandler.execute(initInput('sb-init-plain', 'Hello, do something'));

    const promptEvents = recordEventCalls.filter(c => c.eventType === 'user_prompt');
    expect(promptEvents.length).toBe(1);
    expect(promptEvents[0].payload).toEqual({ prompt: 'Hello, do something' });
    expect(promptEvents[0].generate).toBe(false);
  });

  it('일시 중지된 세션에서는 프롬프트 이벤트를 보내지 않지만 세션은 시작된다 (F1 control)', async () => {
    const { pauseSession, resumeSession } = await import('../../../src/shared/session-pause.js');
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    const sessionId = 'sb-init-paused';
    pauseSession(sessionId);
    try {
      const result = await sessionInitHandler.execute(initInput(sessionId, 'Hello, do something'));

      expect(recordEventCalls.filter(c => c.eventType === 'user_prompt').length).toBe(0);
      expect(startSessionCalls.length).toBe(1);
      expect(result.continue).toBe(true);
    } finally {
      resumeSession(sessionId);
    }
  });

  it('<private> 태그로 감싼 부분은 이벤트 payload에 도달하기 전에 제거된다 (F2)', async () => {
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    await sessionInitHandler.execute(
      initInput('sb-init-partial-private', 'rotate this key <private>AKIA1234567890EXAMPLE</private> please'),
    );

    const promptEvents = recordEventCalls.filter(c => c.eventType === 'user_prompt');
    expect(promptEvents.length).toBe(1);
    const payload = promptEvents[0].payload as { prompt: string };
    expect(payload.prompt).not.toContain('AKIA1234567890EXAMPLE');
    expect(payload.prompt).not.toContain('<private>');
  });

  it('프롬프트 전체가 private이면 user_prompt 이벤트를 아예 보내지 않는다 (F2)', async () => {
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    const result = await sessionInitHandler.execute(
      initInput('sb-init-fully-private', '<private>AKIA1234567890EXAMPLE rotate this</private>'),
    );

    expect(recordEventCalls.filter(c => c.eventType === 'user_prompt').length).toBe(0);
    // Session creation is still unconditional even when the whole prompt is private.
    expect(startSessionCalls.length).toBe(1);
    expect(result.continue).toBe(true);
  });
});
