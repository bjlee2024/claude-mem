import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { getGitUser, clearGitUserCache } from '../../src/utils/git-user.js';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'gu-')); dirs.push(d); return d; }
function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}
afterEach(() => {
  clearGitUserCache();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('getGitUser', () => {
  it('repo-local user.name을 반환한다', () => {
    const d = tmp();
    git(d, 'init');
    git(d, 'config', 'user.name', 'medit-minheecho');
    expect(getGitUser(d)).toBe('medit-minheecho');
  });

  it('앞뒤 공백과 개행을 제거한다', () => {
    const d = tmp();
    git(d, 'init');
    git(d, 'config', 'user.name', '  superman  ');
    expect(getGitUser(d)).toBe('superman');
  });

  it('64자를 넘으면 절단한다', () => {
    const d = tmp();
    git(d, 'init');
    git(d, 'config', 'user.name', 'x'.repeat(100));
    expect(getGitUser(d)).toBe('x'.repeat(64));
  });

  it('존재하지 않는 디렉터리는 null을 반환한다', () => {
    expect(getGitUser('/nonexistent-path-for-test-12345')).toBeNull();
  });

  it('빈 cwd는 null을 반환한다', () => {
    expect(getGitUser('')).toBeNull();
    expect(getGitUser(null)).toBeNull();
    expect(getGitUser(undefined)).toBeNull();
  });

  it('같은 cwd를 두 번 호출하면 캐시된 값을 준다', () => {
    const d = tmp();
    git(d, 'init');
    git(d, 'config', 'user.name', 'first-name');
    expect(getGitUser(d)).toBe('first-name');
    git(d, 'config', 'user.name', 'second-name');
    expect(getGitUser(d)).toBe('first-name');
    clearGitUserCache();
    expect(getGitUser(d)).toBe('second-name');
  });
});
