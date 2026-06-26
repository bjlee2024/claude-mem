import { describe, it, expect } from 'bun:test';
import { captureCliEvent } from '../../src/services/telemetry/cli-telemetry.js';

describe('captureCliEvent (local sink)', () => {
  it('never throws regardless of input', () => {
    expect(() => captureCliEvent('cli_install', { mode: 'client' })).not.toThrow();
    expect(() => captureCliEvent('cli_uninstall')).not.toThrow();
  });

  // Upstream's worker-utils.ts (commit c0b96288) calls captureCliEvent with the
  // full surface: a 3rd `opts?: { person?: boolean }` arg, and `await`s it.
  // Prove the local-sink wrapper accepts that exact call shape.
  it('accepts the optional person opts arg', () => {
    expect(() => captureCliEvent('cli_install', { mode: 'client' }, { person: true })).not.toThrow();
  });

  it('is awaitable like the upstream call site', async () => {
    // mirrors: await captureCliEvent('hook_failed', { ... })
    await expect(captureCliEvent('hook_failed', { reason: 'boom' })).resolves.toBeUndefined();
  });
});
