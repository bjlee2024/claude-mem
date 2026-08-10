import { describe, it, expect, mock, afterAll } from 'bun:test';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll — bun's mock.module is process-global
// and mock.restore() does NOT undo it, so leaving these mocked would break
// unrelated test files later in the same run (see context-client.test.ts for
// the same pattern).
import * as realModeManager from '../../src/services/domain/ModeManager.js';
import * as realSettingsDefaultsManager from '../../src/shared/SettingsDefaultsManager.js';
const realModeManagerSnapshot = { ...realModeManager };
const realSettingsSnapshot = { ...realSettingsDefaultsManager };

// Finding 2: HeaderRenderer.renderHeader() is shared by the worker path
// (generateContext(), which DOES filter observations by git_user in SQL) and
// the client/server-beta path (renderContextFromObservations(), called from
// contextHandler when runtime === 'client'), which renders rows fetched over
// the network via client.contextObservations(...) — a call that applies NO
// author filter. If CLAUDE_MEM_CONTEXT_GIT_USER is set locally, the old code
// still showed "· filtered to <user>" on the client path even though every
// author's observations were included underneath — a false claim the user
// would act on. The note must only render on the path that actually filters.

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [{ id: 'discovery', emoji: 'I' }],
        observation_concepts: [{ id: 'general', emoji: 'G' }],
      }),
      getTypeIcon: () => 'I',
      getWorkEmoji: () => 'W',
      loadMode: () => {},
    }),
  },
}));

// Simulates a local settings.json with CLAUDE_MEM_CONTEXT_GIT_USER set — the
// exact condition that triggered the false-positive note on the client path.
mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => ({
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
      CLAUDE_MEM_CONTEXT_GIT_USER: 'bjlee2024',
    }),
  },
}));

import type { Observation } from '../../src/services/context/types.js';

function testObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 1,
    memory_session_id: 'sess-1',
    type: 'discovery',
    title: 'Some finding',
    subtitle: null,
    narrative: 'narrative text',
    facts: '[]',
    concepts: '["general"]',
    files_read: null,
    files_modified: null,
    discovery_tokens: 10,
    created_at: '2026-08-10T00:00:00.000Z',
    created_at_epoch: Date.parse('2026-08-10T00:00:00.000Z'),
    ...overrides,
  };
}

afterAll(() => {
  mock.module('../../src/services/domain/ModeManager.js', () => realModeManagerSnapshot);
  mock.module('../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
});

describe('renderContextFromObservations (client/server-beta path)', () => {
  it('does not show "filtered to" even when CLAUDE_MEM_CONTEXT_GIT_USER is set locally, because the remote fetch applied no author filter', async () => {
    // Dynamic import so mock.module() above has already patched the module
    // registry before ContextBuilder.ts (and its ContextConfigLoader ->
    // SettingsDefaultsManager import chain) is loaded. A static import here
    // would be hoisted ahead of the mocks and silently read the real settings.
    const { renderContextFromObservations } = await import('../../src/services/context/ContextBuilder.js');

    const result = renderContextFromObservations(
      'acme/widget',
      [testObservation()],
      '/tmp/acme-widget',
      true, // forHuman — the note only ever rendered on the human header
    );

    expect(result).not.toContain('filtered to');
  });
});
