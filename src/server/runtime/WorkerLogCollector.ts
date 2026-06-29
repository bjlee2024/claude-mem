// SPDX-License-Identifier: Apache-2.0
import { readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';

export class WorkerLogCollector {
  private readonly logDir: string;
  private readonly intervalMs: number;
  private offsets = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { logDir: string; intervalMs?: number }) {
    this.logDir = opts.logDir;
    this.intervalMs = opts.intervalMs ?? 3000;
  }

  pollOnce(): void {
    let files: string[];
    try { files = readdirSync(this.logDir).filter(f => f.startsWith('claude-mem-worker-') && f.endsWith('.log')); }
    catch { return; }
    for (const name of files) {
      const path = join(this.logDir, name);
      let size: number;
      try { size = statSync(path).size; } catch { continue; }
      const prev = this.offsets.get(path) ?? size; // first sight: skip backlog, start at EOF
      if (size <= prev) { this.offsets.set(path, size); continue; }
      const len = size - prev;
      const buf = Buffer.alloc(len);
      try {
        const fd = openSync(path, 'r');
        try { readSync(fd, buf, 0, len, prev); } finally { closeSync(fd); }
      } catch { continue; }
      this.offsets.set(path, size);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      if (lines.length) logger.ingestExternalLogs(lines, 'worker');
    }
  }

  start(): void {
    if (this.timer) return;
    this.pollOnce();
    this.timer = setInterval(() => this.pollOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
