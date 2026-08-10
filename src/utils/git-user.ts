import { execFileSync } from 'child_process';
import { homedir } from 'os';

const MAX_LENGTH = 64;

// cwd -> 조회 결과. 훅과 worker 모두 짧게 살거나 세션 단위로 조회하므로
// 무효화 없는 단순 캐시로 충분하다. 테스트는 clearGitUserCache()로 비운다.
const cache = new Map<string, string | null>();

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return p.replace(/^~/, homedir());
  }
  return p;
}

function normalize(raw: string): string | null {
  const collapsed = raw.replace(/[\r\n\t]+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.slice(0, MAX_LENGTH);
}

/**
 * 해당 디렉터리에서 유효한 `git config user.name`을 반환한다.
 *
 * repo-local 설정이 없으면 git이 알아서 global 값으로 폴백하므로, git repo가
 * 아닌 디렉터리에서도 값이 나올 수 있다. 이는 의도된 동작이다 — 비-git
 * 프로젝트에서도 작업한 사람은 동일하다.
 *
 * git 미설치, user.name 미설정, 존재하지 않는 cwd는 모두 null을 반환한다.
 */
export function getGitUser(cwd: string | null | undefined): string | null {
  if (!cwd || cwd.trim() === '') return null;

  const expanded = expandTilde(cwd);
  const cached = cache.get(expanded);
  if (cached !== undefined) return cached;

  let result: string | null = null;
  try {
    const raw = execFileSync('git', ['config', 'user.name'], {
      cwd: expanded,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    result = normalize(raw);
  } catch {
    // git 미설치, user.name 미설정(exit 1), cwd 부재 — 전부 null.
    result = null;
  }

  cache.set(expanded, result);
  return result;
}

export function clearGitUserCache(): void {
  cache.clear();
}
