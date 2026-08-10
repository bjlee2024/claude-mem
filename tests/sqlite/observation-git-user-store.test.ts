import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { storeObservation } from '../../src/services/sqlite/observations/store.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

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

// Inserts a 'processing' pending_messages row for the sdk_sessions row created by tmpDb(),
// as required by SessionStore.storeObservationsAndMarkComplete's completion DELETE.
function insertProcessingMessage(db: Database): number {
  const session = db.query(
    "SELECT id FROM sdk_sessions WHERE content_session_id = 'c1'"
  ).get() as { id: number };
  db.run(
    "INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch) VALUES (?, 'c1', 'observation', 'processing', ?)",
    [session.id, Date.now()]
  );
  const row = db.query('SELECT last_insert_rowid() AS id').get() as { id: number };
  return row.id;
}

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

// Below: the actual production write paths. ResponseProcessor.ts calls
// SessionStore.storeObservations (worker), MemoryRoutes calls
// SessionStore.storeObservation (singular), and both funnel through
// SessionStore.storeObservationsAndMarkComplete when completing a pending
// message. storeObservation()/storeObservations() from observations/store.ts
// above are NOT reachable from production and are covered only to guard the
// standalone helper's own behavior.

describe('SessionStore.storeObservations git_user', () => {
  it('git_user를 저장한다', () => {
    const db = tmpDb();
    const store = new SessionStore(db);
    const { observationIds } = store.storeObservations(
      'm1',
      'acme/widget',
      [{ ...baseObs, git_user: 'bjlee2024' }],
      null
    );
    const row = db.query('SELECT git_user FROM observations WHERE id = ?').get(observationIds[0]) as { git_user: string | null };
    expect(row.git_user).toBe('bjlee2024');
  });

  it('git_user가 없으면 NULL로 저장한다', () => {
    const db = tmpDb();
    const store = new SessionStore(db);
    const { observationIds } = store.storeObservations(
      'm1',
      'acme/widget',
      [{ ...baseObs, title: 'other' }],
      null
    );
    const row = db.query('SELECT git_user FROM observations WHERE id = ?').get(observationIds[0]) as { git_user: string | null };
    expect(row.git_user).toBeNull();
  });
});

describe('SessionStore.storeObservation git_user', () => {
  it('git_user를 저장한다', () => {
    const db = tmpDb();
    const store = new SessionStore(db);
    const { id } = store.storeObservation('m1', 'acme/widget', { ...baseObs, git_user: 'bjlee2024' });
    const row = db.query('SELECT git_user FROM observations WHERE id = ?').get(id) as { git_user: string | null };
    expect(row.git_user).toBe('bjlee2024');
  });

  it('git_user가 없으면 NULL로 저장한다', () => {
    const db = tmpDb();
    const store = new SessionStore(db);
    const { id } = store.storeObservation('m1', 'acme/widget', { ...baseObs, title: 'other' });
    const row = db.query('SELECT git_user FROM observations WHERE id = ?').get(id) as { git_user: string | null };
    expect(row.git_user).toBeNull();
  });
});

describe('SessionStore.storeObservationsAndMarkComplete git_user', () => {
  it('git_user를 저장한다', () => {
    const db = tmpDb();
    const store = new SessionStore(db);
    const messageId = insertProcessingMessage(db);
    const { observationIds } = store.storeObservationsAndMarkComplete(
      'm1',
      'acme/widget',
      [{ ...baseObs, git_user: 'bjlee2024' }],
      null,
      messageId,
      undefined
    );
    const row = db.query('SELECT git_user FROM observations WHERE id = ?').get(observationIds[0]) as { git_user: string | null };
    expect(row.git_user).toBe('bjlee2024');
  });

  it('git_user가 없으면 NULL로 저장한다', () => {
    const db = tmpDb();
    const store = new SessionStore(db);
    const messageId = insertProcessingMessage(db);
    const { observationIds } = store.storeObservationsAndMarkComplete(
      'm1',
      'acme/widget',
      [{ ...baseObs, title: 'other' }],
      null,
      messageId,
      undefined
    );
    const row = db.query('SELECT git_user FROM observations WHERE id = ?').get(observationIds[0]) as { git_user: string | null };
    expect(row.git_user).toBeNull();
  });
});
