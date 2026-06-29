import { describe, it, expect } from 'bun:test';
import { parseOwnerRepo } from '../../src/utils/project-name.js';

describe('parseOwnerRepo', () => {
  it('parses SSH scp-like url', () => {
    expect(parseOwnerRepo('git@github.com:bjlee2024/claude-mem.git')).toBe('bjlee2024/claude-mem');
  });
  it('parses HTTPS url with and without .git', () => {
    expect(parseOwnerRepo('https://github.com/bjlee2024/claude-mem.git')).toBe('bjlee2024/claude-mem');
    expect(parseOwnerRepo('https://github.com/bjlee2024/claude-mem')).toBe('bjlee2024/claude-mem');
  });
  it('parses ssh:// url', () => {
    expect(parseOwnerRepo('ssh://git@github.com/bjlee2024/claude-mem.git')).toBe('bjlee2024/claude-mem');
  });
  it('takes the LAST two segments (subgroup collapses)', () => {
    expect(parseOwnerRepo('https://gitlab.com/group/sub/repo.git')).toBe('sub/repo');
  });
  it('returns null when fewer than two path segments', () => {
    expect(parseOwnerRepo('git@github.com:repo.git')).toBeNull();
    expect(parseOwnerRepo('')).toBeNull();
  });
});
