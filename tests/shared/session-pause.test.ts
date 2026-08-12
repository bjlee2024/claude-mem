import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// paths.ts resolves DATA_DIR (and PAUSED_SESSIONS_PATH) once, as a top-level
// const, the first time it is imported — and Bun's module cache is shared
// across the whole test run (all files in one process), not just this file.
// Pointing CLAUDE_MEM_DATA_DIR at a temp dir and re-importing session-pause.ts
// (as originally drafted) only works if this file happens to be the first
// thing in the whole suite to import paths.ts; running the full suite proved
// that assumption false — a sibling test file imports paths.ts first, so
// PAUSED_SESSIONS_PATH ends up pointing at the real default data dir instead
// of our temp dir. mock.module replaces paths.ts's PAUSED_SESSIONS_PATH
// export outright, independent of import order — the same pattern used in
// tests/services/sync/chroma-mcp-manager-ssl.test.ts.
//
// Capture the real exports before mock.module mutates the live namespace,
// then re-register the snapshot in afterAll: mock.module is process-global
// and mock.restore() does NOT undo it, so without this every later test file
// in the same bun process that imports paths.js would see DATA_DIR, DB_PATH,
// etc. as undefined.
import * as realPaths from '../../src/shared/paths.js';
const realPathsSnapshot = { ...realPaths };

const dir = mkdtempSync(join(tmpdir(), 'sp-'));
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
  // Re-import per test so any future module-level state in session-pause.ts
  // (there is none today — every call reads the file fresh) can't leak
  // between tests either.
  const mod = await import('../../src/shared/session-pause.js?t=' + Math.random());
  return mod;
}

describe('session-pause', () => {
  it('상태 파일이 없으면 중단 아님', async () => {
    const { isSessionPaused } = await load();
    expect(isSessionPaused('s1')).toBe(false);
  });

  it('pause 후에는 중단 상태', async () => {
    const { pauseSession, isSessionPaused } = await load();
    pauseSession('s1');
    expect(isSessionPaused('s1')).toBe(true);
  });

  it('다른 세션은 영향받지 않는다', async () => {
    const { pauseSession, isSessionPaused } = await load();
    pauseSession('s1');
    expect(isSessionPaused('s2')).toBe(false);
  });

  it('resume 하면 풀린다', async () => {
    const { pauseSession, resumeSession, isSessionPaused } = await load();
    pauseSession('s1');
    resumeSession('s1');
    expect(isSessionPaused('s1')).toBe(false);
  });

  it('resume은 다른 세션 항목을 지우지 않는다', async () => {
    const { pauseSession, resumeSession, isSessionPaused } = await load();
    pauseSession('s1');
    pauseSession('s2');
    resumeSession('s1');
    expect(isSessionPaused('s2')).toBe(true);
  });

  it('빈 세션 ID는 중단 아님', async () => {
    const { isSessionPaused } = await load();
    expect(isSessionPaused('')).toBe(false);
    expect(isSessionPaused(null)).toBe(false);
    expect(isSessionPaused(undefined)).toBe(false);
  });

  it('깨진 JSON이어도 예외를 던지지 않고 중단 아님으로 처리한다', async () => {
    writeFileSync(stateFile, '{ this is not json');
    const { isSessionPaused } = await load();
    expect(() => isSessionPaused('s1')).not.toThrow();
    expect(isSessionPaused('s1')).toBe(false);
  });

  it('24시간이 지난 항목은 중단으로 보지 않는다', async () => {
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(stateFile, JSON.stringify({ old: stale }));
    const { isSessionPaused } = await load();
    expect(isSessionPaused('old')).toBe(false);
  });

  it('24시간이 안 지난 항목은 유지된다', async () => {
    const recent = Date.now() - 1 * 60 * 60 * 1000;
    writeFileSync(stateFile, JSON.stringify({ fresh: recent }));
    const { isSessionPaused } = await load();
    expect(isSessionPaused('fresh')).toBe(true);
  });

  it('쓰기 시점에 만료 항목이 파일에서 제거된다', async () => {
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(stateFile, JSON.stringify({ old: stale }));
    const { pauseSession } = await load();
    pauseSession('new');
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(Object.keys(saved)).toEqual(['new']);
  });

  it('임시 파일을 남기지 않는다', async () => {
    const { pauseSession } = await load();
    pauseSession('s1');
    // Temp name is pid-scoped (see write() in session-pause.ts) so concurrent
    // writers never share one — confirm nothing is left behind under that name.
    expect(existsSync(`${stateFile}.${process.pid}.tmp`)).toBe(false);
  });

  it('성공하면 pauseSession/resumeSession이 true를 반환한다', async () => {
    const { pauseSession, resumeSession } = await load();
    expect(pauseSession('s1')).toBe(true);
    expect(resumeSession('s1')).toBe(true);
  });

  it('쓰기 실패 시 pauseSession/resumeSession이 false를 반환하고 상태는 바뀌지 않는다', async () => {
    // Simulate a write failure (root-owned state dir, full disk, read-only
    // $HOME) by pointing PAUSED_SESSIONS_PATH at a directory this process
    // cannot write into. mkdirSync(dirname, {recursive:true}) is a no-op on an
    // already-existing dir, so the failure surfaces at writeFileSync (EACCES).
    const roDir = mkdtempSync(join(tmpdir(), 'sp-ro-'));
    const roFile = join(roDir, 'paused-sessions.json');
    mock.module('../../src/shared/paths.js', () => ({ PAUSED_SESSIONS_PATH: roFile }));
    chmodSync(roDir, 0o500); // read + execute only, no write
    try {
      const { pauseSession, resumeSession, isSessionPaused } = await load();
      expect(pauseSession('blocked')).toBe(false);
      // A failed write must not fool isSessionPaused into reporting success.
      expect(isSessionPaused('blocked')).toBe(false);
      expect(resumeSession('blocked')).toBe(false);
    } finally {
      chmodSync(roDir, 0o700);
      rmSync(roDir, { recursive: true, force: true });
      // Restore the file-level mock for any later test in this file/suite.
      mock.module('../../src/shared/paths.js', () => ({ PAUSED_SESSIONS_PATH: stateFile }));
    }
  });
});
