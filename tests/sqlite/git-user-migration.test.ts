import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';

const dirs: string[] = [];
function tmpDb(): Database {
  const d = mkdtempSync(join(tmpdir(), 'gum-'));
  dirs.push(d);
  return new Database(join(d, 'test.db'));
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function columnNames(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
}

describe('git_user 마이그레이션', () => {
  it('observations와 sdk_sessions에 git_user 컬럼을 추가한다', () => {
    const db = tmpDb();
    new MigrationRunner(db).runAllMigrations();
    expect(columnNames(db, 'observations')).toContain('git_user');
    expect(columnNames(db, 'sdk_sessions')).toContain('git_user');
  });

  it('두 번 실행해도 실패하지 않는다', () => {
    const db = tmpDb();
    new MigrationRunner(db).runAllMigrations();
    expect(() => new MigrationRunner(db).runAllMigrations()).not.toThrow();
    expect(columnNames(db, 'observations').filter(c => c === 'git_user')).toHaveLength(1);
  });

  it('git_user 인덱스를 만든다', () => {
    const db = tmpDb();
    new MigrationRunner(db).runAllMigrations();
    const indexes = db.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='observations'"
    ).all() as Array<{ name: string }>;
    expect(indexes.map(i => i.name)).toContain('idx_observations_git_user');
  });
});
