// Shared bun test preload. Registered via bunfig.toml [test].preload so the
// hooks below apply to the ENTIRE suite, which runs in a single bun process.
import { afterEach } from 'bun:test';
import { __resetTelemetryForTests } from '../src/services/telemetry/telemetry.js';

// The local-sink telemetry module keeps a process-wide `isShutdown` latch.
// A test that calls shutdownTelemetry() would otherwise suppress telemetry
// behavior in later test files (the latch leaks across files because the whole
// suite shares one process). Reset it between every test to isolate files.
afterEach(() => {
  __resetTelemetryForTests();
});
