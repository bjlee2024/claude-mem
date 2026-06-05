// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — durable offline write queue for thin clients. Hooks
// append failed remote writes here; the next hook invocation flushes them.
// Append-only NDJSON keeps concurrent hooks safe without locking; flush takes
// the file atomically (rename) so two flushers never double-send.
import {
  existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, mkdirSync,
  readdirSync,
} from 'node:fs';
import { dirname, basename } from 'node:path';

export interface SpoolRecord {
  id: string;
  kind: 'event' | 'session_start' | 'session_end';
  endpoint: string;
  body: unknown;
  projectName: string;
  enqueuedAtEpoch: number;
  attempts?: number;
}

export interface SpoolSendResult { ok: boolean; permanent?: boolean }
export type SpoolSender = (record: SpoolRecord) => Promise<SpoolSendResult>;

export interface SpoolOptions { path: string; maxRecords?: number }

export class Spool {
  private readonly path: string;
  private readonly maxRecords: number;

  constructor(opts: SpoolOptions) {
    this.path = opts.path;
    this.maxRecords = opts.maxRecords ?? 5000;
  }

  append(record: SpoolRecord): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(record) + '\n', { mode: 0o600 });
      this.trim();
    } catch { /* best-effort; never throw into a hook */ }
  }

  depth(): number { return this.read(this.path).length; }
  peekIds(): string[] { return this.read(this.path).map(r => r.id); }

  async flush(send: SpoolSender, budget = 200): Promise<void> {
    // Reclaim orphaned .flushing.<pid> files left behind by crashed processes.
    // We only steal a file if its owner PID is provably dead — process.kill(pid, 0)
    // throws ESRCH when the process is gone (safe to reclaim) and either succeeds
    // or throws EPERM when it is alive (skip; a concurrent flush owns it).
    // This runs before the early-return so even an empty spool heals orphans.
    const myFlushFile = `${this.path}.flushing.${process.pid}`;
    try {
      const dir = dirname(this.path);
      const prefix = `${basename(this.path)}.flushing.`;
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(prefix)) continue;
        const orphanPath = `${dir}/${name}`;
        if (orphanPath === myFlushFile) continue; // never steal our own slot
        const pidStr = name.slice(prefix.length);
        const pid = parseInt(pidStr, 10);
        let isOrphan = isNaN(pid); // unparseable PID → treat as orphan
        if (!isOrphan) {
          try { process.kill(pid, 0); /* alive (or EPERM) → skip */ }
          catch (e: unknown) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') isOrphan = true; }
        }
        if (!isOrphan) continue;
        // Merge orphan records to the front of pending.ndjson (FIFO: older records first)
        const orphanRecords = this.read(orphanPath);
        const pendingRecords = this.read(this.path);
        const merged = [...orphanRecords, ...pendingRecords];
        if (merged.length > 0) {
          writeFileSync(this.path, merged.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
        }
        unlinkSync(orphanPath);
      }
    } catch { /* recovery is best-effort; never throw into caller */ }

    if (!existsSync(this.path)) return;
    const taking = myFlushFile;
    try { renameSync(this.path, taking); } catch { return; } // someone else took it
    const records = this.read(taking);
    const requeue: SpoolRecord[] = [];
    let processed = 0;
    for (const r of records) {
      if (processed >= budget) { requeue.push(r); continue; }
      processed++;
      try {
        const res = await send(r);
        if (!res.ok && !res.permanent) requeue.push({ ...r, attempts: (r.attempts ?? 0) + 1 });
        // ok or permanent => drop
      } catch { requeue.push({ ...r, attempts: (r.attempts ?? 0) + 1 }); }
    }
    try { unlinkSync(taking); } catch { /* ignore */ }
    for (const r of requeue) this.append(r);
  }

  private read(path: string): SpoolRecord[] {
    try {
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l) as SpoolRecord; } catch { return null; } })
        .filter((r): r is SpoolRecord => r !== null);
    } catch { return []; }
  }

  private trim(): void {
    const all = this.read(this.path);
    if (all.length <= this.maxRecords) return;
    const kept = all.slice(all.length - this.maxRecords);
    try { writeFileSync(this.path, kept.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* ignore */ }
  }
}
