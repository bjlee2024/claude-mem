import { describe, it, expect, beforeEach } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

describe('logger forward buffer', () => {
  beforeEach(() => { delete process.env.CLAUDE_MEM_LOG_FORWARD_LEVEL; logger.drainForwardBuffer(); });

  it('buffers WARN/ERROR by default and drains them once', () => {
    logger.info('HOOK', 'noise');     // below default WARN
    logger.warn('HOOK', 'careful');
    logger.error('DB', 'broke');
    const drained = logger.drainForwardBuffer();
    expect(drained.length).toBe(2);
    expect(drained.join('\n')).toContain('careful');
    expect(drained.join('\n')).toContain('broke');
    expect(logger.drainForwardBuffer().length).toBe(0); // emptied
  });

  it('honors CLAUDE_MEM_LOG_FORWARD_LEVEL=INFO', () => {
    process.env.CLAUDE_MEM_LOG_FORWARD_LEVEL = 'INFO';
    logger.drainForwardBuffer();
    logger.info('HOOK', 'now kept');
    expect(logger.drainForwardBuffer().some(l => l.includes('now kept'))).toBe(true);
  });
});
