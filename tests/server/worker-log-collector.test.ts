import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../src/utils/logger.js';
import { WorkerLogCollector } from '../../src/server/runtime/WorkerLogCollector.js';

describe('WorkerLogCollector', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wlc-')); logger.clearRecentLogs(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('ingests only newly appended lines as source=worker', () => {
    const f = join(dir, 'claude-mem-2026-06-29.log');
    writeFileSync(f, '[2026-06-29 00:00:00.000] [INFO ] [SYSTEM] boot\n');
    const c = new WorkerLogCollector({ logDir: dir });
    c.pollOnce(); // consumes the existing line
    appendFileSync(f, '[2026-06-29 00:00:01.000] [WARN ] [DB] slow query\n');
    c.pollOnce(); // should pick up only the new line
    const out = logger.getRecentLogs();
    expect(out).toContain('slow query');
    expect(out).toContain('[worker]');
    // second poll with no new bytes adds nothing
    const before = logger.getRecentLogs().length;
    c.pollOnce();
    expect(logger.getRecentLogs().length).toBe(before);
  });
});
