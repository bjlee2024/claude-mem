import { describe, it, expect } from 'bun:test';
import { resolveSessionGitUser } from '../../src/server/generation/processGeneratedResponse.js';

describe('resolveSessionGitUser', () => {
  it('세션 metadata에서 gitUser를 꺼낸다', () => {
    expect(resolveSessionGitUser({ project: 'acme/widget', gitUser: 'bjlee2024' })).toBe('bjlee2024');
  });

  it('gitUser가 없으면 null을 준다', () => {
    expect(resolveSessionGitUser({ project: 'acme/widget' })).toBeNull();
    expect(resolveSessionGitUser(null)).toBeNull();
    expect(resolveSessionGitUser(undefined)).toBeNull();
  });

  it('문자열이 아니면 null을 준다', () => {
    expect(resolveSessionGitUser({ gitUser: 42 })).toBeNull();
    expect(resolveSessionGitUser({ gitUser: '' })).toBeNull();
  });
});
