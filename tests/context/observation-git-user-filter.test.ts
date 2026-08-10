import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveGitUserFilter } from '../../src/services/context/ContextConfigLoader.js';
import { queryObservations, queryObservationsMulti } from '../../src/services/context/ObservationCompiler.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import type { ContextConfig } from '../../src/services/context/types.js';

describe('resolveGitUserFilter', () => {
  it('all이면 null(필터 없음)을 준다', () => {
    expect(resolveGitUserFilter('all', () => 'bjlee2024')).toBeNull();
  });

  it('설정이 비어 있으면 null을 준다', () => {
    expect(resolveGitUserFilter('', () => 'bjlee2024')).toBeNull();
  });

  it('me면 현재 git user로 해석한다', () => {
    expect(resolveGitUserFilter('me', () => 'bjlee2024')).toBe('bjlee2024');
  });

  it('me인데 git user를 못 읽으면 전원으로 폴백한다', () => {
    expect(resolveGitUserFilter('me', () => null)).toBeNull();
  });

  it('구체적 이름이면 그 이름으로 필터한다', () => {
    expect(resolveGitUserFilter('superman', () => 'bjlee2024')).toBe('superman');
  });
});

// --- Filtered-query coverage: real rows, real SQL, asserts the correct subset ---

const dirs: string[] = [];
function tmpDb(): Database {
  const d = mkdtempSync(join(tmpdir(), 'ctx-gu-'));
  dirs.push(d);
  const db = new Database(join(d, 'test.db'));
  new MigrationRunner(db).runAllMigrations();

  const insertSession = (cid: string, mid: string, project: string) => {
    db.run(
      "INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?,?,?,'2026-08-10T00:00:00Z',0,'active')",
      [cid, mid, project]
    );
  };
  insertSession('c1', 'm1', 'acme/widget');
  insertSession('c2', 'm2', 'acme/widget');
  insertSession('c3', 'm3', 'acme/widget');
  insertSession('c4', 'm4', 'acme/other');

  const insertObs = (mid: string, project: string, title: string, user: string | null) => {
    db.run(
      `INSERT INTO observations
         (memory_session_id, project, type, title, narrative, facts, concepts, files_read, files_modified, git_user, content_hash, created_at, created_at_epoch)
       VALUES (?,?,?,?,?,'[]','["general"]','[]','[]',?,?, '2026-08-10T00:00:00Z', 0)`,
      [mid, project, 'discovery', title, 'narrative', user, `${mid}-${title}`]
    );
  };
  insertObs('m1', 'acme/widget', 'observation by first user', 'bjlee2024');
  insertObs('m2', 'acme/widget', 'observation by second user', 'superman');
  insertObs('m3', 'acme/widget', 'observation with no author', null);
  insertObs('m4', 'acme/other', 'other project observation', 'bjlee2024');
  return db;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function baseConfig(overrides: Partial<ContextConfig> = {}): ContextConfig {
  return {
    totalObservationCount: 50,
    fullObservationCount: 0,
    sessionCount: 10,
    showReadTokens: false,
    showWorkTokens: false,
    showSavingsAmount: false,
    showSavingsPercent: true,
    observationTypes: new Set(['discovery']),
    observationConcepts: new Set(['general']),
    fullObservationField: 'narrative',
    showLastSummary: true,
    showLastMessage: false,
    gitUserFilter: null,
    ...overrides,
  };
}

describe('queryObservations gitUserFilter', () => {
  it('필터가 없으면 프로젝트의 모든 작성자 관측을 반환한다', () => {
    const db = new SessionStore(tmpDb());
    const rows = queryObservations(db, 'acme/widget', baseConfig());
    expect(rows.length).toBe(3);
  });

  it('필터가 있으면 해당 작성자의 관측만 반환한다', () => {
    const db = new SessionStore(tmpDb());
    const rows = queryObservations(db, 'acme/widget', baseConfig({ gitUserFilter: 'bjlee2024' }));
    expect(rows.length).toBe(1);
    expect(rows[0]!.git_user).toBe('bjlee2024');
  });

  it('필터에 매치되는 작성자가 없으면 빈 배열을 반환한다', () => {
    const db = new SessionStore(tmpDb());
    const rows = queryObservations(db, 'acme/widget', baseConfig({ gitUserFilter: 'nobody' }));
    expect(rows.length).toBe(0);
  });
});

describe('SessionStore.getMostRecentGitUserForProject', () => {
  // Regression coverage: CLAUDE_MEM_CONTEXT_GIT_USER=me must resolve against
  // the identity actually captured for this project's sessions, not whatever
  // git identity the worker daemon's own (arbitrary) process cwd would report.
  it("returns the most recently started session's git_user for the project", () => {
    const db = new SessionStore(tmpDb());
    // tmpDb() seeds acme/widget sessions m1 (bjlee2024), m2 (superman), m3 (null),
    // all with started_at_epoch=0 in insertion order — m3 is inserted last, so it
    // is "most recent", but its own git_user is null (it has no owning session row
    // git_user set — sdk_sessions.git_user is never populated by tmpDb's insertSession,
    // only observations.git_user is). Insert a session-level git_user for m3 directly
    // to exercise the "most recent has an author" branch precisely.
    db.db.run("UPDATE sdk_sessions SET git_user = 'work-alice', started_at_epoch = 100 WHERE memory_session_id = 'm3'");
    expect(db.getMostRecentGitUserForProject('acme/widget')).toBe('work-alice');
  });

  it('falls back to an older session when the most recent has no git_user', () => {
    const db = new SessionStore(tmpDb());
    db.db.run("UPDATE sdk_sessions SET git_user = 'bjlee2024', started_at_epoch = 50 WHERE memory_session_id = 'm1'");
    db.db.run("UPDATE sdk_sessions SET started_at_epoch = 100 WHERE memory_session_id = 'm3'"); // most recent, git_user still NULL
    expect(db.getMostRecentGitUserForProject('acme/widget')).toBe('bjlee2024');
  });

  it('returns null when no session for the project has a git_user (never an empty context)', () => {
    const db = new SessionStore(tmpDb());
    expect(db.getMostRecentGitUserForProject('acme/widget')).toBeNull();
  });

  it('is scoped to the given project', () => {
    const db = new SessionStore(tmpDb());
    db.db.run("UPDATE sdk_sessions SET git_user = 'bjlee2024' WHERE memory_session_id = 'm4'"); // acme/other
    expect(db.getMostRecentGitUserForProject('acme/widget')).toBeNull();
    expect(db.getMostRecentGitUserForProject('acme/other')).toBe('bjlee2024');
  });
});

describe('queryObservationsMulti gitUserFilter', () => {
  it('필터가 없으면 전체 프로젝트의 모든 작성자 관측을 반환한다', () => {
    const db = new SessionStore(tmpDb());
    const rows = queryObservationsMulti(db, ['acme/widget', 'acme/other'], baseConfig());
    expect(rows.length).toBe(4);
  });

  it('필터가 있으면 여러 프로젝트에 걸쳐 해당 작성자의 관측만 반환한다', () => {
    const db = new SessionStore(tmpDb());
    const rows = queryObservationsMulti(db, ['acme/widget', 'acme/other'], baseConfig({ gitUserFilter: 'bjlee2024' }));
    expect(rows.length).toBe(2);
    expect(rows.every(r => r.git_user === 'bjlee2024')).toBe(true);
  });
});
