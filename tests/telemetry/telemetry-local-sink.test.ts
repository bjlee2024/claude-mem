import { describe, it, expect, afterEach } from 'bun:test';
import { captureEvent, shutdownTelemetry, __resetTelemetryForTests } from '../../src/services/telemetry/telemetry.js';

describe('telemetry local sink (instrument-only)', () => {
  afterEach(() => __resetTelemetryForTests());

  it('captureEvent never throws and never opens a network client', () => {
    // posthog-node is intentionally not a dependency; if telemetry.ts imported
    // it, this module would fail to resolve. Reaching here proves no network dep.
    expect(() => captureEvent('worker_started', { trigger: 'startup' })).not.toThrow();
    expect(() => captureEvent('worker_started', undefined, { person: true })).not.toThrow();
  });

  it('captureEvent swallows bad input', () => {
    const prev = process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
    // Force the DEBUG path so JSON.stringify/scrubProperties run on bad input.
    process.env.CLAUDE_MEM_TELEMETRY_DEBUG = '1';
    try {
      // @ts-expect-error deliberately wrong type
      expect(() => captureEvent(null)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
      else process.env.CLAUDE_MEM_TELEMETRY_DEBUG = prev;
    }
  });

  it('capture after shutdown writes nothing', async () => {
    const prev = process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
    process.env.CLAUDE_MEM_TELEMETRY_DEBUG = '1';
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error test stub
    process.stderr.write = (chunk: string) => { written.push(String(chunk)); return true; };
    try {
      await shutdownTelemetry();
      captureEvent('worker_started', { trigger: 'late' });
    } finally {
      process.stderr.write = orig;
      if (prev === undefined) delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
      else process.env.CLAUDE_MEM_TELEMETRY_DEBUG = prev;
    }
    // The isShutdown latch must suppress even the debug write.
    expect(written.join('')).toBe('');
  });

  it('DEBUG unset writes nothing to stderr', () => {
    const prev = process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
    delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error test stub
    process.stderr.write = (chunk: string) => { written.push(String(chunk)); return true; };
    try {
      captureEvent('observation_created', { observation_type: 'feature' });
    } finally {
      process.stderr.write = orig;
      if (prev === undefined) delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
      else process.env.CLAUDE_MEM_TELEMETRY_DEBUG = prev;
    }
    expect(written.join('')).toBe('');
  });

  it('shutdownTelemetry resolves without a network round-trip', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('CLAUDE_MEM_TELEMETRY_DEBUG=1 writes a local line to stderr and sends nothing', () => {
    const prev = process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
    process.env.CLAUDE_MEM_TELEMETRY_DEBUG = '1';
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error test stub
    process.stderr.write = (chunk: string) => { written.push(String(chunk)); return true; };
    try {
      captureEvent('observation_created', { observation_type: 'feature' });
    } finally {
      process.stderr.write = orig;
      if (prev === undefined) delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
      else process.env.CLAUDE_MEM_TELEMETRY_DEBUG = prev;
    }
    expect(written.join('')).toContain('[telemetry]');
    expect(written.join('')).toContain('observation_created');
  });
});
