import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

// Regression coverage for the ID-hydration filter gap: getObservationsByIds
// and getSessionSummariesByIds are the SQLite hydration step used after a
// Chroma/semantic match, and previously silently ignored gitUser and
// platformSource even when the caller passed them — see
// tests/worker/search/git-user-search-wiring.test.ts for the end-to-end
// SearchManager-level regression test covering the same gap.
describe('SessionStore.getObservationsByIds — gitUser / platformSource', () => {
  let store: SessionStore;

  function seedObservation(
    contentSessionId: string,
    memorySessionId: string,
    project: string,
    gitUser: string,
    platformSource: string,
    title: string,
  ): number {
    const sdkId = store.createSDKSession(contentSessionId, project, 'prompt', undefined, platformSource, gitUser);
    store.updateMemorySessionId(sdkId, memorySessionId);
    const { id } = store.storeObservation(memorySessionId, project, {
      type: 'discovery',
      title,
      subtitle: null,
      facts: [],
      narrative: 'narrative',
      concepts: [],
      files_read: [],
      files_modified: [],
      git_user: gitUser,
    }, 1);
    return id;
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('filters by gitUser via the sdk_sessions subquery', () => {
    const alice = seedObservation('c1', 'm1', 'p', 'alice', 'claude', 'alice obs');
    const bob = seedObservation('c2', 'm2', 'p', 'bob', 'claude', 'bob obs');

    const filtered = store.getObservationsByIds([alice, bob], { gitUser: 'alice' });
    expect(filtered.map(r => r.id)).toEqual([alice]);

    const unfiltered = store.getObservationsByIds([alice, bob], {});
    expect(unfiltered.length).toBe(2);
  });

  it('filters by platformSource via the sdk_sessions subquery', () => {
    const claudeObs = seedObservation('c3', 'm3', 'p', 'alice', 'claude', 'claude obs');
    const codexObs = seedObservation('c4', 'm4', 'p', 'alice', 'codex', 'codex obs');

    const filtered = store.getObservationsByIds([claudeObs, codexObs], { platformSource: 'codex' });
    expect(filtered.map(r => r.id)).toEqual([codexObs]);
  });

  it('combines gitUser and platformSource filters', () => {
    const match = seedObservation('c5', 'm5', 'p', 'alice', 'codex', 'match');
    const wrongUser = seedObservation('c6', 'm6', 'p', 'bob', 'codex', 'wrong user');
    const wrongSource = seedObservation('c7', 'm7', 'p', 'alice', 'claude', 'wrong source');

    const filtered = store.getObservationsByIds([match, wrongUser, wrongSource], {
      gitUser: 'alice',
      platformSource: 'codex',
    });
    expect(filtered.map(r => r.id)).toEqual([match]);
  });
});

describe('SessionStore.getSessionSummariesByIds — gitUser / platformSource', () => {
  let store: SessionStore;

  function seedSummary(
    contentSessionId: string,
    memorySessionId: string,
    project: string,
    gitUser: string,
    platformSource: string,
  ): number {
    const sdkId = store.createSDKSession(contentSessionId, project, 'prompt', undefined, platformSource, gitUser);
    store.updateMemorySessionId(sdkId, memorySessionId);
    const { id } = store.storeSummary(memorySessionId, project, {
      request: 'req',
      investigated: 'inv',
      learned: 'learned',
      completed: 'done',
      next_steps: 'next',
      notes: null,
    }, 1);
    return id;
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('filters by gitUser via the sdk_sessions subquery (session_summaries has no git_user column)', () => {
    const alice = seedSummary('c1', 'm1', 'p', 'alice', 'claude');
    const bob = seedSummary('c2', 'm2', 'p', 'bob', 'claude');

    const filtered = store.getSessionSummariesByIds([alice, bob], { gitUser: 'alice' });
    expect(filtered.map(r => r.id)).toEqual([alice]);
  });

  it('filters by platformSource via the sdk_sessions subquery', () => {
    const claudeSummary = seedSummary('c3', 'm3', 'p', 'alice', 'claude');
    const codexSummary = seedSummary('c4', 'm4', 'p', 'alice', 'codex');

    const filtered = store.getSessionSummariesByIds([claudeSummary, codexSummary], { platformSource: 'codex' });
    expect(filtered.map(r => r.id)).toEqual([codexSummary]);
  });
});
