import { describe, it, expect } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

describe('logger unified store', () => {
  it('tags the process own logs with [server] source', () => {
    logger.clearRecentLogs();
    logger.info('SYSTEM', 'hello world');
    const out = logger.getRecentLogs();
    expect(out).toContain('[SYSTEM]');
    expect(out).toContain('[server]');
    expect(out).toContain('hello world');
  });

  it('ingests external worker lines verbatim and returns them', () => {
    logger.clearRecentLogs();
    logger.ingestExternalLogs(
      ['[2026-06-29 00:00:00.000] [INFO ] [WORKER] generation done'],
      'worker',
    );
    const out = logger.getRecentLogs();
    expect(out).toContain('[WORKER]');
    expect(out).toContain('[worker]');
    expect(out).toContain('generation done');
  });
});
