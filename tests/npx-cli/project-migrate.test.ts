// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeRename, runProjectCommand } from '../../src/npx-cli/commands/project.js';

// ---------------------------------------------------------------------------
// computeRename unit tests
// ---------------------------------------------------------------------------
describe('computeRename', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `project-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: tmpDir });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:testowner/testrepo.git'], {
      cwd: tmpDir,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns changed=true and newName=owner/repo when origin is set', () => {
    const result = computeRename(tmpDir);
    expect(result.changed).toBe(true);
    expect(result.newName).toBe('testowner/testrepo');
    // oldName is just the folder basename, not owner/repo
    expect(result.oldName).not.toContain('/');
  });

  it('returns correct oldName as git repo root basename', () => {
    const result = computeRename(tmpDir);
    // tmpDir itself is the git root, so oldName = basename(tmpDir)
    expect(result.oldName).toBe(tmpDir.split('/').at(-1));
  });
});

describe('computeRename — no git origin (not in a git repo)', () => {
  let noGitDir: string;

  beforeEach(() => {
    noGitDir = join(tmpdir(), `no-git-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(noGitDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(noGitDir, { recursive: true, force: true });
  });

  it('returns changed=false when cwd has no git origin (both sides use cwd basename)', () => {
    const result = computeRename(noGitDir);
    // Both oldFolderName and getProjectName fall back to basename(cwd) when not in a git repo
    expect(result.changed).toBe(false);
    expect(result.oldName).toBe(result.newName);
  });
});

// ---------------------------------------------------------------------------
// --dry-run: no server calls are made
// ---------------------------------------------------------------------------
describe('runProjectCommand --dry-run', () => {
  let tmpDir: string;
  const logs: string[] = [];
  let origLog: typeof console.log;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `project-migrate-dryrun-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: tmpDir });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:dryrunowner/dryrunrepo.git'], {
      cwd: tmpDir,
    });
    origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = origLog;
    rmSync(tmpDir, { recursive: true, force: true });
    logs.length = 0;
  });

  it('prints rename preview and dry-run message without making server calls', async () => {
    await runProjectCommand(['migrate', '--dry-run'], tmpDir);
    const output = logs.join('\n');
    expect(output).toContain('→');
    expect(output).toContain('dry-run');
    // If a network call had been attempted, the test would throw (no server configured).
    // Reaching here means no network call was made.
  });

  it('outputs old→new names in the preview line', async () => {
    await runProjectCommand(['migrate', '--dry-run'], tmpDir);
    const previewLine = logs.find((l) => l.includes('→'));
    expect(previewLine).toBeDefined();
    expect(previewLine).toContain('dryrunowner/dryrunrepo');
  });
});

// ---------------------------------------------------------------------------
// no-change scenario
// ---------------------------------------------------------------------------
describe('runProjectCommand no-change scenario', () => {
  let noGitDir: string;
  const logs: string[] = [];
  let origLog: typeof console.log;

  beforeEach(() => {
    noGitDir = join(tmpdir(), `no-change-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(noGitDir, { recursive: true });
    origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = origLog;
    rmSync(noGitDir, { recursive: true, force: true });
    logs.length = 0;
  });

  it('prints no-change message and returns without error', async () => {
    await runProjectCommand(['migrate'], noGitDir);
    const output = logs.join('\n');
    expect(output).toContain('No change');
  });
});
