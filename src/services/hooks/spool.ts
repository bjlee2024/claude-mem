// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — durable offline write queue for thin clients. Hooks
// append failed remote writes here; the next hook invocation flushes them.
// Append-only NDJSON keeps concurrent hooks safe without locking; flush takes
// the file atomically (rename) so two flushers never double-send.
import {
  existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';

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
    if (!existsSync(this.path)) return;
    const taking = `${this.path}.flushing.${process.pid}`;
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
