import { homedir } from 'os'
import path from 'path';
import { execFileSync } from 'child_process';
import { logger } from './logger.js';

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return p.replace(/^~/, homedir())
  }
  return p
}

/**
 * Resolve the git repository ROOT for a directory, so a project's name is
 * stable across its subdirectories and worktrees (#2663). Returns the absolute
 * repo-root path, or null when `dir` is not inside a git repo (or git is
 * unavailable). `--show-toplevel` resolves to the working-tree root even when
 * invoked from a worktree or a nested subdirectory.
 */
function findGitRepoRoot(dir: string): string | null {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return root || null;
  } catch {
    // Not a git repo, git not installed, or dir does not exist — fall back to basename.
    return null;
  }
}

function gitRemoteOriginUrl(repoRoot: string): string | null {
  try {
    const url = execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return url || null;
  } catch { return null; }
}

export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  const expanded = expandTilde(cwd)

  // #2663 — derive the project name from the git repo root when inside a repo so
  // the name is stable across subdirectories/worktrees. Fall back to the cwd
  // basename when not in a repo.
  const repoRoot = findGitRepoRoot(expanded);
  if (repoRoot) {
    const origin = gitRemoteOriginUrl(repoRoot);
    if (origin) {
      const ownerRepo = parseOwnerRepo(origin);
      if (ownerRepo) return ownerRepo;
    }
  }
  const nameSource = repoRoot ?? expanded;

  const basename = path.basename(nameSource);

  if (basename === '') {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const driveMatch = cwd.match(/^([A-Z]):\\/i);
      if (driveMatch) {
        const driveLetter = driveMatch[1].toUpperCase();
        const projectName = `drive-${driveLetter}`;
        logger.info('PROJECT_NAME', 'Drive root detected', { cwd, projectName });
        return projectName;
      }
    }
    logger.warn('PROJECT_NAME', 'Root directory detected, using fallback', { cwd });
    return 'unknown-project';
  }

  return basename;
}

export interface ProjectContext {
  primary: string;
  parent: string | null;
  isWorktree: boolean;
  allProjects: string[];
}

export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const name = getProjectName(cwd);
  return { primary: name, parent: null, isWorktree: false, allProjects: [name] };
}

/**
 * Normalize a git remote URL to "owner/repo". Handles scp-like SSH
 * (git@host:owner/repo.git), https://host/owner/repo(.git), and
 * ssh://host/owner/repo. Returns null when the path has fewer than two
 * segments (caller falls back to the repo basename).
 */
export function parseOwnerRepo(url: string): string | null {
  if (!url) return null;
  let s = url.trim();
  // strip a trailing .git
  s = s.replace(/\.git$/i, '');
  // drop scheme: ssh:// https:// http:// git://
  s = s.replace(/^[a-z]+:\/\//i, '');
  // scp-like "git@host:owner/repo" → take part after the first ':'
  // url-like "host/owner/repo" → take part after the first '/'
  let pathPart: string;
  if (s.includes(':') && !s.includes('/')) {
    pathPart = s.slice(s.indexOf(':') + 1);
  } else if (s.includes(':') && s.indexOf(':') < s.indexOf('/')) {
    pathPart = s.slice(s.indexOf(':') + 1);
  } else {
    pathPart = s.slice(s.indexOf('/') + 1);
  }
  // strip leading userinfo@host if still present (url-like without scheme handled above)
  const segments = pathPart.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}
