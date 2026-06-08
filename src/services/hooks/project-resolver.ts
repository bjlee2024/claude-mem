// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — resolves a repo working directory to a server project
// UUID, preserving worker-mode's per-repo isolation. Caches name->uuid in
// ~/.claude-mem/project-map.json so each repo hits POST /v1/projects/resolve at
// most once per machine.
import { dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getProjectContext } from '../../utils/project-name.js';

export interface ProjectResolveClient {
  resolveProject(name: string): Promise<string>;
}

export interface ProjectResolverOptions {
  client: ProjectResolveClient;
  mapPath: string;
}

export class ProjectResolver {
  private readonly client: ProjectResolveClient;
  private readonly mapPath: string;
  private cache: Record<string, string>;

  constructor(opts: ProjectResolverOptions) {
    this.client = opts.client;
    this.mapPath = opts.mapPath;
    this.cache = this.load();
  }

  // Same policy as worker mode (src/utils/project-name.ts): derive the project
  // name from the git repo ROOT (stable across subdirectories) and use the
  // `parent/worktree` composite when in a git worktree. Falls back to the cwd
  // basename when not inside a git repo. This keeps client/server-beta project
  // grouping identical to the local worker runtime.
  static projectName(cwd: string): string {
    return getProjectContext(cwd).primary;
  }

  async resolve(cwd: string): Promise<string> {
    const name = ProjectResolver.projectName(cwd);
    const cached = this.cache[name];
    if (cached) return cached;
    const id = await this.client.resolveProject(name);
    this.cache[name] = id;
    this.persist();
    return id;
  }

  private load(): Record<string, string> {
    try {
      if (!existsSync(this.mapPath)) return {};
      return JSON.parse(readFileSync(this.mapPath, 'utf8')) as Record<string, string>;
    } catch { return {}; }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.mapPath), { recursive: true });
      writeFileSync(this.mapPath, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
    } catch { /* best-effort cache; resolution still works without persistence */ }
  }
}
