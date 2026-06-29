import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { getProjectName, getProjectContext } from '../../src/utils/project-name.js';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'pn-')); dirs.push(d); return d; }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) { execFileSync('git', args, { cwd, stdio: ['ignore','ignore','ignore'] }); }

describe('getProjectName origin-based', () => {
  it('git repo with origin → owner/repo (independent of folder name)', () => {
    const d = tmp();
    git(d, 'init'); git(d, 'remote', 'add', 'origin', 'git@github.com:bjlee2024/claude-mem.git');
    expect(getProjectName(d)).toBe('bjlee2024/claude-mem');
    expect(getProjectContext(d).primary).toBe('bjlee2024/claude-mem');
    expect(getProjectContext(d).isWorktree).toBe(false);
  });
  it('git repo without origin → repo root basename', () => {
    const d = tmp();
    git(d, 'init');
    expect(getProjectName(d)).toBe(require('path').basename(d));
  });
  it('non-git dir → cwd basename', () => {
    const d = tmp(); // mkdtemp dir, not git-init'd
    expect(getProjectName(d)).toBe(require('path').basename(d));
  });
});
