import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';

const dirs: string[] = [];
function tmpDb(): Database {
  const d = mkdtempSync(join(tmpdir(), 'gusf-'));
  dirs.push(d);
  const db = new Database(join(d, 'test.db'));
  new MigrationRunner(db).runAllMigrations();

  db.run("INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, git_user, started_at, started_at_epoch, status) VALUES ('c1','m1','acme/widget','bjlee2024','2026-08-10T00:00:00Z',0,'active')");
  db.run("INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, git_user, started_at, started_at_epoch, status) VALUES ('c2','m2','acme/widget','superman','2026-08-10T00:00:00Z',0,'active')");

  const insertObs = (mid: string, title: string, user: string) => {
    db.run(
      "INSERT INTO observations (memory_session_id, project, type, title, narrative, facts, concepts, files_read, files_modified, git_user, content_hash, created_at, created_at_epoch) VALUES (?,?,?,?,?,'[]','[]','[]','[]',?,?, '2026-08-10T00:00:00Z', 0)",
      [mid, 'acme/widget', 'discovery', title, 'deployment narrative', user, `${mid}-${title}`]
    );
  };
  insertObs('m1', 'deployment by first user', 'bjlee2024');
  insertObs('m2', 'deployment by second user', 'superman');
  return db;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('gitUser 검색 필터', () => {
  it('지정한 작성자의 관측만 반환한다', () => {
    const db = tmpDb();
    const search = new SessionSearch(db);
    const results = search.searchObservations('deployment', { gitUser: 'bjlee2024' });
    expect(results.length).toBe(1);
    expect(results[0]!.git_user).toBe('bjlee2024');
  });

  it('필터가 없으면 전원을 반환한다', () => {
    const db = tmpDb();
    const search = new SessionSearch(db);
    const results = search.searchObservations('deployment', {});
    expect(results.length).toBe(2);
  });

  it('session_summaries 검색에서도 SQL 에러가 나지 않는다', () => {
    const db = tmpDb();
    const search = new SessionSearch(db);
    // session_summaries에는 git_user 컬럼이 없다. 세션 서브쿼리를 쓰지 않으면
    // 여기서 "no such column: git_user"로 터진다.
    expect(() => search.searchSessions('deployment', { gitUser: 'bjlee2024' })).not.toThrow();
  });
});
