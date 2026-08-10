import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { storeObservation } from '../../src/services/sqlite/observations/store.js';

const dirs: string[] = [];
function tmpDb(): Database {
  const d = mkdtempSync(join(tmpdir(), 'ogu-'));
  dirs.push(d);
  const db = new Database(join(d, 'test.db'));
  new MigrationRunner(db).runAllMigrations();
  db.run(
    "INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES ('c1', 'm1', 'acme/widget', '2026-08-10T00:00:00Z', 0, 'active')"
  );
  return db;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const baseObs = {
  type: 'discovery',
  title: 'NPM Registry Latest Version',
  subtitle: null,
  facts: [],
  narrative: 'n',
  concepts: [],
  files_read: [],
  files_modified: [],
};

describe('storeObservation git_user', () => {
  it('git_user를 저장한다', () => {
    const db = tmpDb();
    const { id } = storeObservation(db, 'm1', 'acme/widget', { ...baseObs, git_user: 'bjlee2024' });
    const row = db.query('SELECT git_user FROM observations WHERE id = ?').get(id) as { git_user: string | null };
    expect(row.git_user).toBe('bjlee2024');
  });

  it('git_user가 없으면 NULL로 저장한다', () => {
    const db = tmpDb();
    const { id } = storeObservation(db, 'm1', 'acme/widget', { ...baseObs, title: 'other' });
    const row = db.query('SELECT git_user FROM observations WHERE id = ?').get(id) as { git_user: string | null };
    expect(row.git_user).toBeNull();
  });
});
