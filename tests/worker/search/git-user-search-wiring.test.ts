import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [{ id: 'discovery', icon: 'I' }],
        observation_concepts: [],
      }),
      getObservationTypes: () => [{ id: 'discovery', icon: 'I' }],
      getTypeIcon: (_type: string) => 'I',
      getWorkEmoji: () => 'W',
    }),
  },
}));

import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { FormattingService } from '../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../src/services/worker/TimelineService.js';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';

// End-to-end wiring check for the gitUser search filter (Task 8). This
// exercises the same call shape the HTTP layer produces (SearchManager.search
// receiving a plain object of string values, as req.query would deliver),
// not just SessionSearch directly — earlier tasks in this feature hit bugs
// where a filter reached SessionSearch fine in isolation but was silently
// dropped by SearchManager.normalizeParams or the /api/search route before
// it got there.
describe('gitUser filter end-to-end wiring (SearchManager.search)', () => {
  let db: Database;
  let store: SessionStore;
  let search: SessionSearch;
  let manager: SearchManager;

  const PROJECT = 'git-user-wiring-project';

  function seedObservation(contentSessionId: string, memorySessionId: string, gitUser: string, title: string): void {
    const sdkId = store.createSDKSession(contentSessionId, PROJECT, 'prompt', undefined, undefined, gitUser);
    store.updateMemorySessionId(sdkId, memorySessionId);
    store.storeObservation(memorySessionId, PROJECT, {
      type: 'discovery',
      title,
      subtitle: null,
      facts: [],
      narrative: 'deployment wiring narrative',
      concepts: [],
      files_read: [],
      files_modified: [],
      git_user: gitUser,
    }, 1);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    store = new SessionStore(db);
    search = new SessionSearch(db);

    seedObservation('c1', 'm1', 'bjlee2024', 'deployment by first user');
    seedObservation('c2', 'm2', 'superman', 'deployment by second user');

    // ChromaSync intentionally null: forces the real FTS5 fallback path in
    // SearchManager.search(), which is the path a worker without semantic
    // search configured actually takes.
    manager = new SearchManager(search, store, null, new FormattingService(), new TimelineService());
  });

  afterEach(() => {
    db.close();
  });

  it('SearchManager.search (as invoked via /api/search with query-string args) honors gitUser', async () => {
    // Args as they arrive from Express req.query / callWorkerAPI: everything
    // is a plain string, and unknown keys are NOT pre-filtered.
    const response = await manager.search({
      query: 'deployment',
      project: PROJECT,
      gitUser: 'bjlee2024',
      format: 'json',
    });

    expect(response.observations.length).toBe(1);
    expect(response.observations[0].git_user).toBe('bjlee2024');
  });

  it('SearchManager.search with no gitUser returns both authors', async () => {
    const response = await manager.search({
      query: 'deployment',
      project: PROJECT,
      format: 'json',
    });

    expect(response.observations.length).toBe(2);
  });
});
