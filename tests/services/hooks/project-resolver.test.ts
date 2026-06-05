// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('uses basename of cwd as the project name', async () => {
    const seen: string[] = [];
    const client = { resolveProject: async (name: string) => { seen.push(name); return 'x'; } };
    const r = new ProjectResolver({ client: client as any, mapPath: join(dir, 'm.json') });
    await r.resolve('/a/b/my-repo');
    expect(seen).toEqual(['my-repo']);
  });
});
