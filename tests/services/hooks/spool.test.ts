// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Spool, type SpoolRecord } from '../../../src/services/hooks/spool.js';

describe('Spool', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cm-spool-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function newSpool() { return new Spool({ path: join(dir, 'pending.ndjson'), maxRecords: 5 }); }
  const rec = (id: string) => ({ id, kind: 'event' as const, endpoint: '/v1/events', body: { x: id }, projectName: 'p', enqueuedAtEpoch: 1 });

  it('append then flush replays FIFO and drops on success', async () => {
    const s = newSpool();
    s.append(rec('a')); s.append(rec('b'));
    const sent: string[] = [];
    await s.flush(async (r) => { sent.push(r.id); return { ok: true }; });
    expect(sent).toEqual(['a', 'b']);
    expect(s.depth()).toBe(0);
  });

  it('re-appends eligible failures, drops permanent (4xx)', async () => {
    const s = newSpool();
    s.append(rec('a')); s.append(rec('b'));
    await s.flush(async (r) => r.id === 'a' ? { ok: false, permanent: false } : { ok: false, permanent: true });
    expect(s.depth()).toBe(1); // 'a' re-queued, 'b' dropped
  });

  it('trims oldest beyond maxRecords', () => {
    const s = newSpool();
    for (const id of ['a','b','c','d','e','f','g']) s.append(rec(id));
    expect(s.depth()).toBe(5);
    expect(s.peekIds()).toEqual(['c','d','e','f','g']);
  });

  it('flush on empty spool is a no-op and does not create the file', async () => {
    const s = newSpool();
    await s.flush(async () => ({ ok: true }));
    expect(existsSync(join(dir, 'pending.ndjson'))).toBe(false);
    expect(s.depth()).toBe(0);
  });

  it('crash recovery: orphaned .flushing.<dead-pid> is reclaimed and record is sent', async () => {
    const spoolPath = join(dir, 'pending.ndjson');
    const orphanPath = `${spoolPath}.flushing.999999`;
    const orphanRec: SpoolRecord = {
      id: 'orphan-1', kind: 'event', endpoint: '/v1/events',
      body: { x: 'orphan-1' }, projectName: 'p', enqueuedAtEpoch: 1,
    };
    // Write the orphan file (crash after rename, no pending.ndjson)
    writeFileSync(orphanPath, JSON.stringify(orphanRec) + '\n', { mode: 0o600 });

    const s = newSpool();
    const sent: string[] = [];
    await s.flush(async (r) => { sent.push(r.id); return { ok: true }; });

    expect(sent).toContain('orphan-1');
    expect(s.depth()).toBe(0);
    expect(existsSync(orphanPath)).toBe(false);
  });

  it('live-pid not stolen: .flushing.<current-pid> is left untouched', async () => {
    const spoolPath = join(dir, 'pending.ndjson');
    const livePath = `${spoolPath}.flushing.${process.pid}`;
    const liveRec: SpoolRecord = {
      id: 'live-1', kind: 'event', endpoint: '/v1/events',
      body: { x: 'live-1' }, projectName: 'p', enqueuedAtEpoch: 1,
    };
    writeFileSync(livePath, JSON.stringify(liveRec) + '\n', { mode: 0o600 });

    const s = newSpool();
    const sent: string[] = [];
    await s.flush(async (r) => { sent.push(r.id); return { ok: true }; });

    // The live-pid file must survive and its record must NOT have been sent
    expect(existsSync(livePath)).toBe(true);
    expect(sent).not.toContain('live-1');
  });

  it('thrown-error requeues the record', async () => {
    const s = newSpool();
    s.append(rec('e1'));
    await s.flush(async () => { throw new Error('net'); });
    expect(s.depth()).toBe(1);
  });
});
