import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dir: string;
const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sc-'));
  process.env.CLAUDE_MEM_DATA_DIR = dir;
});
afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

async function load() {
  return await import('../../src/npx-cli/commands/session.js?t=' + Math.random());
}

describe('session 커맨드', () => {
  it('pause 하면 그 세션이 중단 상태가 된다', async () => {
    const { runSessionCommand } = await load();
    const { isSessionPaused } = await import('../../src/shared/session-pause.js?t=' + Math.random());
    runSessionCommand(['pause', 'abc']);
    expect(isSessionPaused('abc')).toBe(true);
  });

  it('resume 하면 풀린다', async () => {
    const { runSessionCommand } = await load();
    const { isSessionPaused } = await import('../../src/shared/session-pause.js?t=' + Math.random());
    runSessionCommand(['pause', 'abc']);
    runSessionCommand(['resume', 'abc']);
    expect(isSessionPaused('abc')).toBe(false);
  });

  it('세션 ID가 없으면 상태를 바꾸지 않는다', async () => {
    const { runSessionCommand } = await load();
    const { isSessionPaused } = await import('../../src/shared/session-pause.js?t=' + Math.random());
    runSessionCommand(['pause']);
    expect(isSessionPaused('')).toBe(false);
  });

  it('알 수 없는 하위 명령은 상태를 바꾸지 않는다', async () => {
    const { runSessionCommand } = await load();
    const { isSessionPaused } = await import('../../src/shared/session-pause.js?t=' + Math.random());
    runSessionCommand(['bogus', 'abc']);
    expect(isSessionPaused('abc')).toBe(false);
  });
});
