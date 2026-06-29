// SPDX-License-Identifier: Apache-2.0
//
// Task 5: Tests for ServerBetaClient.renameProject and ProjectResolver.applyRename
import { describe, it, expect, beforeEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { ServerBetaClient } from '../../src/services/hooks/server-beta-client.js';
import { ProjectResolver } from '../../src/services/hooks/project-resolver.js';

// ─── ServerBetaClient.renameProject ────────────────────────────────────────

describe('ServerBetaClient.renameProject', () => {
  it('POSTs to /v1/projects/rename with {from, to} body', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;

    const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      const payload = { renamed: true, id: 'proj-uuid-456', name: 'new-project' };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new ServerBetaClient({
      serverBaseUrl: 'http://localhost:4002',
      apiKey: 'test-key',
      fetchImpl: fakeFetch,
    });

    const result = await client.renameProject('old-project', 'new-project');

    expect(capturedUrl).toBe('http://localhost:4002/v1/projects/rename');
    expect(capturedBody).toEqual({ from: 'old-project', to: 'new-project' });
    expect(result.renamed).toBe(true);
    expect(result.id).toBe('proj-uuid-456');
    expect(result.name).toBe('new-project');
  });

  it('returns renamed:false when server indicates no rename (merged)', async () => {
    const fakeFetch = async (_url: string, _init: RequestInit): Promise<Response> => {
      const payload = { renamed: false, merged: true, id: 'existing-uuid' };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new ServerBetaClient({
      serverBaseUrl: 'http://localhost:4002',
      apiKey: 'test-key',
      fetchImpl: fakeFetch,
    });

    const result = await client.renameProject('project-a', 'project-b');
    expect(result.renamed).toBe(false);
    expect(result.merged).toBe(true);
    expect(result.id).toBe('existing-uuid');
  });
});

// ─── ProjectResolver.applyRename ──────────────────────────────────────────

describe('ProjectResolver.applyRename', () => {
  let tmpDir: string;
  let mapPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-mem-test-'));
    mapPath = join(tmpDir, 'project-map.json');
  });

  function cleanup() {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it('removes from key and sets to->id in persisted map', () => {
    // Pre-seed the resolver with an existing mapping
    const mockClient = { resolveProject: async (_name: string) => 'unused-id' };
    const resolver = new ProjectResolver({ client: mockClient, mapPath });

    // Seed an initial entry by calling resolve-like internal manipulation
    // We use applyRename from scratch: from key doesn't need to pre-exist for
    // the rename call itself, but let's seed it via a prior applyRename
    resolver.applyRename('old-project', 'old-project', 'proj-id-123');

    // Now rename it
    resolver.applyRename('old-project', 'new-project', 'proj-id-123');

    // Check the persisted file
    const persisted = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, string>;
    expect(persisted['old-project']).toBeUndefined();
    expect(persisted['new-project']).toBe('proj-id-123');
  });

  it('handles rename when from key does not exist in cache', () => {
    const mockClient = { resolveProject: async (_name: string) => 'unused-id' };
    const resolver = new ProjectResolver({ client: mockClient, mapPath });

    // applyRename even if from doesn't exist should not throw, and should set to->id
    resolver.applyRename('nonexistent', 'new-name', 'abc-uuid');

    const persisted = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, string>;
    expect(persisted['nonexistent']).toBeUndefined();
    expect(persisted['new-name']).toBe('abc-uuid');
  });

  it('persists multiple entries correctly after rename', () => {
    const mockClient = { resolveProject: async (_name: string) => 'unused-id' };
    const resolver = new ProjectResolver({ client: mockClient, mapPath });

    // Seed two entries
    resolver.applyRename('proj-a', 'proj-a', 'id-a');
    resolver.applyRename('proj-b', 'proj-b', 'id-b');

    // Rename proj-a -> proj-a-renamed
    resolver.applyRename('proj-a', 'proj-a-renamed', 'id-a');

    const persisted = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, string>;
    expect(persisted['proj-a']).toBeUndefined();
    expect(persisted['proj-a-renamed']).toBe('id-a');
    expect(persisted['proj-b']).toBe('id-b');

    cleanup();
  });
});
