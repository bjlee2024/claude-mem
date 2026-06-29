import { describe, it, expect } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

describe('logger unified store', () => {
  it('tags the process own logs with [server] source (default — no env override)', () => {
    // Ensure worker/client env vars are absent for this assertion.
    const savedContainer = process.env.CLAUDE_MEM_CONTAINER_MODE;
    const savedRuntime   = process.env.CLAUDE_MEM_RUNTIME;
    delete process.env.CLAUDE_MEM_CONTAINER_MODE;
    delete process.env.CLAUDE_MEM_RUNTIME;

    logger.clearRecentLogs();
    logger.info('SYSTEM', 'hello world');
    const out = logger.getRecentLogs();
    expect(out).toContain('[SYSTEM]');
    expect(out).toContain('[server]');
    expect(out).toContain('hello world');

    // Restore
    if (savedContainer !== undefined) process.env.CLAUDE_MEM_CONTAINER_MODE = savedContainer;
    if (savedRuntime   !== undefined) process.env.CLAUDE_MEM_RUNTIME         = savedRuntime;
  });

  it('tags own logs with [worker] when CLAUDE_MEM_CONTAINER_MODE=worker', () => {
    const savedContainer = process.env.CLAUDE_MEM_CONTAINER_MODE;
    const savedRuntime   = process.env.CLAUDE_MEM_RUNTIME;
    process.env.CLAUDE_MEM_CONTAINER_MODE = 'worker';
    delete process.env.CLAUDE_MEM_RUNTIME;

    logger.clearRecentLogs();
    logger.info('SYSTEM', 'worker process message');
    const out = logger.getRecentLogs();
    expect(out).toContain('[worker]');
    expect(out).not.toContain('[server]');
    expect(out).toContain('worker process message');

    // Restore
    if (savedContainer !== undefined) {
      process.env.CLAUDE_MEM_CONTAINER_MODE = savedContainer;
    } else {
      delete process.env.CLAUDE_MEM_CONTAINER_MODE;
    }
    if (savedRuntime !== undefined) process.env.CLAUDE_MEM_RUNTIME = savedRuntime;
  });

  it('tags own logs with [client] when CLAUDE_MEM_RUNTIME=client', () => {
    const savedContainer = process.env.CLAUDE_MEM_CONTAINER_MODE;
    const savedRuntime   = process.env.CLAUDE_MEM_RUNTIME;
    delete process.env.CLAUDE_MEM_CONTAINER_MODE;
    process.env.CLAUDE_MEM_RUNTIME = 'client';

    logger.clearRecentLogs();
    logger.info('SYSTEM', 'client process message');
    const out = logger.getRecentLogs();
    expect(out).toContain('[client]');
    expect(out).not.toContain('[server]');

    // Restore
    if (savedContainer !== undefined) process.env.CLAUDE_MEM_CONTAINER_MODE = savedContainer;
    if (savedRuntime !== undefined) {
      process.env.CLAUDE_MEM_RUNTIME = savedRuntime;
    } else {
      delete process.env.CLAUDE_MEM_RUNTIME;
    }
  });

  it('ingests external worker lines and inserts [worker] tag when no source field present', () => {
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

  it('ingestExternalLogs does not double-tag a line that already carries [worker]', () => {
    logger.clearRecentLogs();
    const alreadyTagged = '[2026-06-29 00:00:00.000] [WARN ] [HOOK  ] [worker] some warning';
    logger.ingestExternalLogs([alreadyTagged], 'worker');
    const out = logger.getRecentLogs();
    expect(out).toContain('[worker]');
    // Must appear exactly once — no [worker] ... [worker] duplication.
    const matches = out.match(/\[worker\]/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('ingestExternalLogs does not double-tag a line that already carries [client]', () => {
    logger.clearRecentLogs();
    const alreadyTagged = '[2026-06-29 00:00:00.000] [WARN ] [HOOK  ] [client] forwarded warning';
    logger.ingestExternalLogs([alreadyTagged], 'client');
    const out = logger.getRecentLogs();
    expect(out).toContain('[client]');
    const matches = out.match(/\[client\]/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('ingestExternalLogs does not add [client] when line already carries [server]', () => {
    logger.clearRecentLogs();
    // Simulate a pre-fix line (from an old client binary) still tagged [server].
    const serverLine = '[2026-06-29 00:00:00.000] [WARN ] [HOOK  ] [server] old-format warning';
    logger.ingestExternalLogs([serverLine], 'client');
    const out = logger.getRecentLogs();
    // [server] is already a known source — must not also have [client].
    expect(out).toContain('[server]');
    expect(out).not.toContain('[client]');
  });
});
