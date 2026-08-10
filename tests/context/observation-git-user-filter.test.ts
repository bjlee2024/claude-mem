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
