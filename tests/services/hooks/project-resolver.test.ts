// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ProjectResolver } from '../../../src/services/hooks/project-resolver.js';

describe('ProjectResolver', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cm-resolver-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('resolves via client on miss, then serves from cache without a 2nd call', async () => {
    let calls = 0;
    const client = { resolveProject: async (_name: string) => { calls++; return 'uuid-1'; } };
    const r = new ProjectResolver({ client: client as any, mapPath: join(dir, 'project-map.json') });
    expect(await r.resolve('/home/u/repo-a')).toBe('uuid-1');
    expect(await r.resolve('/home/u/repo-a')).toBe('uuid-1');
    expect(calls).toBe(1);
  });

  it('falls back to cwd basename when not inside a git repo', async () => {
    const seen: string[] = [];
    const client = { resolveProject: async (name: string) => { seen.push(name); return 'x'; } };
    const r = new ProjectResolver({ client: client as any, mapPath: join(dir, 'm.json') });
    await r.resolve('/a/b/my-repo');
    expect(seen).toEqual(['my-repo']);
  });

  it('uses the git repo ROOT name when run from a subdirectory (worker-parity)', async () => {
    // Real git repo at `dir`; resolving from a nested subdir must yield the
    // repo-root folder name, not the subdir name.
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    const sub = join(dir, 'src', 'server');
    mkdirSync(sub, { recursive: true });

    const seen: string[] = [];
    const client = { resolveProject: async (name: string) => { seen.push(name); return 'uuid'; } };
    const r = new ProjectResolver({ client: client as any, mapPath: join(dir, 'pm.json') });
    await r.resolve(sub);

    // git rev-parse --show-toplevel resolves to the repo root; its basename is
    // the temp dir's basename (e.g. cm-resolver-XXXX), NOT 'server'.
    expect(seen[0]).toBe(basename(dir));
    expect(seen[0]).not.toBe('server');
  });
});
