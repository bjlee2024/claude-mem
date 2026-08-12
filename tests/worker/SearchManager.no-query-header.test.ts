import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

mock.module('../../src/services/domain/ModeManager.js', () => ({
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
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';

// Regression coverage for a bug where SearchManager.search() interpolated a
// missing `query` straight into the result header, producing the literal
// string "undefined" in user-facing text (`No results found matching
// "undefined"` / `Found 3 result(s) matching "undefined"`). The `/filter`
// skill's queries are always query-less (gitUser/project/type filters
// only), so this path runs on every use of that command.
describe('SearchManager.search() result header when no query is passed', () => {
  let db: Database;
  let store: SessionStore;
  let search: SessionSearch;
  let manager: SearchManager;

  const PROJECT = 'no-query-header-project';

  function seedObservation(contentSessionId: string, memorySessionId: string, title: string): void {
    const sdkId = store.createSDKSession(contentSessionId, PROJECT, 'prompt');
    store.updateMemorySessionId(sdkId, memorySessionId);
    store.storeObservation(memorySessionId, PROJECT, {
      type: 'discovery',
      title,
      subtitle: null,
      facts: [],
      narrative: 'no-query header regression narrative',
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    store = new SessionStore(db);
    search = new SessionSearch(db);

    manager = new SearchManager(search, store, null, new FormattingService(), new TimelineService());
  });

  afterEach(() => {
    db.close();
  });

  it('renders "No results found" with no "undefined" when a query-less filter search finds nothing', async () => {
    const response = await manager.search({ project: PROJECT, limit: 20 });

    const text: string = response.content[0].text;
    expect(text).toBe('No results found');
    expect(text).not.toContain('undefined');
  });

  it('renders "Found N result(s)" with no "undefined" when a query-less filter search finds results', async () => {
    seedObservation('c1', 'm1', 'observation one');
    seedObservation('c2', 'm2', 'observation two');

    const response = await manager.search({ project: PROJECT, limit: 20 });

    const text: string = response.content[0].text;
    expect(text).toContain('Found 2 result(s) (2 obs, 0 sessions, 0 prompts)');
    expect(text).not.toContain('undefined');
  });

  it('keeps the existing "matching" wording when a query is present', async () => {
    const response = await manager.search({ project: PROJECT, query: 'nonexistent-term-xyz', limit: 20 });

    const text: string = response.content[0].text;
    expect(text).toBe('No results found matching "nonexistent-term-xyz"');
  });
});
