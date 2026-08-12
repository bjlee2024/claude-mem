import { describe, it, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, chmodSync } from 'fs';
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
  try { unlinkSync(`${stateFile}.${process.pid}.tmp`); } catch { /* no tmp file */ }
  // A few tests below set process.exitCode to verify CLI failure behavior.
  // Bun's process.exitCode is sticky: assigning `undefined` after it has been
  // set to a truthy value does NOT clear it back (verified directly against
  // this Bun build), so 0 is the only reliable "clean slate" value.
  process.exitCode = 0;
});

afterEach(() => {
  // Don't let a test that deliberately sets process.exitCode leak into the
  // overall test run's exit status.
  process.exitCode = 0;
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

  it('알 수 없는 하위 명령은 종료 코드 1을 설정한다', async () => {
    const { runSessionCommand } = await load();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      runSessionCommand(['bogus', 'abc']);
      expect(process.exitCode).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('세션 ID가 없으면 종료 코드 1을 설정한다', async () => {
    const { runSessionCommand } = await load();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      runSessionCommand(['pause']);
      expect(process.exitCode).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('성공한 명령은 종료 코드를 건드리지 않는다', async () => {
    const { runSessionCommand } = await load();
    runSessionCommand(['pause', 'abc']);
    expect(process.exitCode).toBe(0);
  });

  it('pauseSession 쓰기가 실패하면 CLI가 실패를 알리고 종료 코드 1을 설정하며 성공 메시지를 출력하지 않는다', async () => {
    // Simulate a write failure (root-owned state dir, full disk, read-only
    // $HOME) by pointing PAUSED_SESSIONS_PATH at a directory this process
    // cannot write into.
    const roDir = mkdtempSync(join(tmpdir(), 'sc-ro-'));
    const roFile = join(roDir, 'paused-sessions.json');
    mock.module('../../src/shared/paths.js', () => ({ PAUSED_SESSIONS_PATH: roFile }));
    chmodSync(roDir, 0o500); // read + execute only, no write
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { runSessionCommand } = await load();
      runSessionCommand(['pause', 'abc']);
      expect(process.exitCode).toBe(1);
      expect(errSpy).toHaveBeenCalled();
      // Must never claim success when the write actually failed.
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('paused'));
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
      chmodSync(roDir, 0o700);
      rmSync(roDir, { recursive: true, force: true });
      mock.module('../../src/shared/paths.js', () => ({ PAUSED_SESSIONS_PATH: stateFile }));
    }
  });
});
