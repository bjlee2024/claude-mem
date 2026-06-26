// Shared bun test preload. Registered via bunfig.toml [test].preload so the
// hooks below apply to the ENTIRE suite, which runs in a single bun process.
import { afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { __resetTelemetryForTests } from '../src/services/telemetry/telemetry.js';

// Data-dir tripwire (Phase 6, worker-restart plan): no test may ever touch the
// real ~/.claude-mem. src/shared/paths.ts freezes DATA_DIR at first evaluation
// (env CLAUDE_MEM_DATA_DIR wins), and module-level consts like ProcessManager's
// PID_FILE inherit that frozen value — so the env var must point at a safe
// directory BEFORE any module loads. This preload runs first (bunfig.toml
// [test].preload), so when the env var is unset we pin it to a fresh per-run
// temp dir. Tests that want tighter isolation still override it per-file /
// per-test; this only fills the default so nothing can fall through to the real
// data dir. The leaked temp dir per run is deliberate: correctness over cleanup
// (an afterAll here could rip the dir out from under frozen module constants
// while later test files still run). NOTE: unlike upstream we do NOT register a
// posthog-node mock here — this fork's telemetry is a local-sink shim that never
// imports posthog-node, so there is no real client to stub.
if (!process.env.CLAUDE_MEM_DATA_DIR) {
  process.env.CLAUDE_MEM_DATA_DIR = mkdtempSync(join(tmpdir(), 'claude-mem-test-run-'));
}

// The local-sink telemetry module keeps a process-wide `isShutdown` latch.
// A test that calls shutdownTelemetry() would otherwise suppress telemetry
// behavior in later test files (the latch leaks across files because the whole
// suite shares one process). Reset it between every test to isolate files.
afterEach(() => {
  __resetTelemetryForTests();
});
