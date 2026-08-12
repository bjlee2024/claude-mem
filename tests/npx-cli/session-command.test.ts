import { describe, it, expect, beforeEach, afterAll, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Same trap as tests/shared/session-pause.test.ts: paths.ts resolves
// PAUSED_SESSIONS_PATH once, as a top-level const, the first time it is
// imported anywhere in the process — Bun's module cache is shared across the
// whole test run, not just this file. Reassigning CLAUDE_MEM_DATA_DIR per
// test has no effect once some other file has already imported paths.js.
// mock.module replaces paths.ts's PAUSED_SESSIONS_PATH export outright,
// independent of import order.
//
// Capture the real exports before mock.module mutates the live namespace,
// then re-register the snapshot in afterAll: mock.module is process-global
// and mock.restore() does NOT undo it, so without this every later test file
// in the same bun process that imports paths.js would see DATA_DIR, DB_PATH,
// etc. as undefined.
import * as realPaths from '../../src/shared/paths.js';
const realPathsSnapshot = { ...realPaths };

const dir = mkdtempSync(join(tmpdir(), 'sc-'));
const stateFile = join(dir, 'paused-sessions.json');

mock.module('../../src/shared/paths.js', () => ({
  PAUSED_SESSIONS_PATH: stateFile,
}));

afterAll(() => {
  mock.module('../../src/shared/paths.js', () => realPathsSnapshot);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset state between tests since PAUSED_SESSIONS_PATH is fixed for the file.
  try { unlinkSync(stateFile); } catch { /* no file yet */ }
  try { unlinkSync(`${stateFile}.tmp`); } catch { /* no tmp file */ }
});

async function load() {
  // Re-import per test so any future module-level state in session.ts can't
  // leak between tests either.
  return await import('../../src/npx-cli/commands/session.js?t=' + Math.random());
}

async function loadPause() {
  return await import('../../src/shared/session-pause.js?t=' + Math.random());
}

describe('session 커맨드', () => {
  it('pause 하면 그 세션이 중단 상태가 된다', async () => {
    const { runSessionCommand } = await load();
    const { isSessionPaused } = await loadPause();
    runSessionCommand(['pause', 'abc']);
    expect(isSessionPaused('abc')).toBe(true);
  });

  it('resume 하면 풀린다', async () => {
    const { runSessionCommand } = await load();
    const { isSessionPaused } = await loadPause();
    runSessionCommand(['pause', 'abc']);
    runSessionCommand(['resume', 'abc']);
    expect(isSessionPaused('abc')).toBe(false);
  });

  it('세션 ID가 없으면 상태를 바꾸지 않는다', async () => {
    const { runSessionCommand } = await load();
    const { isSessionPaused } = await loadPause();
    runSessionCommand(['pause']);
    expect(isSessionPaused('')).toBe(false);
  });

  it('알 수 없는 하위 명령은 상태를 바꾸지 않는다', async () => {
    const { runSessionCommand } = await load();
    const { isSessionPaused } = await loadPause();
    runSessionCommand(['bogus', 'abc']);
    expect(isSessionPaused('abc')).toBe(false);
  });

  it('status는 중단되지 않은 세션에 recording을 출력한다', async () => {
    const { runSessionCommand } = await load();
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      runSessionCommand(['status', 'abc']);
      expect(logSpy).toHaveBeenCalledWith('recording (abc)');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('status는 중단된 세션에 paused를 출력한다', async () => {
    const { runSessionCommand } = await load();
    runSessionCommand(['pause', 'abc']);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      runSessionCommand(['status', 'abc']);
      expect(logSpy).toHaveBeenCalledWith('paused (abc)');
    } finally {
      logSpy.mockRestore();
    }
  });
});
