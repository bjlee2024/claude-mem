import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { createSDKSession } from '../../src/services/sqlite/sessions/create.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const dirs: string[] = [];
function tmpDb(): Database {
  const d = mkdtempSync(join(tmpdir(), 'sigu-'));
  dirs.push(d);
  const db = new Database(join(d, 'test.db'));
  new MigrationRunner(db).runAllMigrations();
  return db;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('세션 생성 시 git_user 저장', () => {
  // SessionRoutes가 실제로 호출하는 경로.
  it('SessionStore가 gitUser를 sdk_sessions에 기록한다', () => {
    const db = tmpDb();
    const store = new SessionStore(db);
    store.createSDKSession('sess-1', 'acme/widget', 'hello', undefined, 'claude', 'bjlee2024');
    const row = db.query('SELECT git_user FROM sdk_sessions WHERE content_session_id = ?')
      .get('sess-1') as { git_user: string | null };
    expect(row.git_user).toBe('bjlee2024');
  });

  it('gitUser가 없으면 NULL로 남는다', () => {
    const db = tmpDb();
    const store = new SessionStore(db);
    store.createSDKSession('sess-2', 'acme/widget', 'hello', undefined, 'claude');
    const row = db.query('SELECT git_user FROM sdk_sessions WHERE content_session_id = ?')
      .get('sess-2') as { git_user: string | null };
    expect(row.git_user).toBeNull();
  });

  // 중복 구현도 같은 동작이어야 한다.
  it('sessions/create.ts의 함수도 gitUser를 기록한다', () => {
    const db = tmpDb();
    createSDKSession(db, 'sess-3', 'acme/widget', 'hello', undefined, 'claude', 'superman');
    const row = db.query('SELECT git_user FROM sdk_sessions WHERE content_session_id = ?')
      .get('sess-3') as { git_user: string | null };
    expect(row.git_user).toBe('superman');
  });
});
