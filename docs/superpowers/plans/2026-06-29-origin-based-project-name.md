# origin 기반 프로젝트 분류 — 구현 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프로젝트 이름을 git origin 기반 `owner/repo`로 분류하고(클론 위치 무관), 기존 폴더명 프로젝트를 일회성 CLI로 마이그레이션한다.

**Architecture:** 단일 소스 `src/utils/project-name.ts`를 origin 기반으로 바꾸면 모든 런타임(client/server-beta/worker)이 동일하게 적용된다. 마이그레이션은 `claude-mem project migrate`가 repo별로 구→신 이름을 계산해 server-beta의 `POST /v1/projects/rename`(rename-or-merge)을 호출하고 `project-map.json`을 갱신한다.

**Tech Stack:** TypeScript, Bun(`bun test`), Express, Postgres(server-beta), Node `child_process`(git).

## Global Constraints

- 이름 형식: git+origin → `owner/repo`(origin URL의 마지막 2 path segment, 끝의 `.git` 제거). git+no-origin → repo root basename. non-git → cwd basename.
- `parseOwnerRepo` 파싱 실패(segment < 2 등) → `null` 반환, 호출부는 repo basename으로 fallback.
- git worktree → 같은 `owner/repo`로 통합(`getProjectContext`에서 composite 제거).
- rename 라우트는 **반드시 `ServerV1PostgresRoutes`**(server-beta가 실제 마운트하는 모듈)에 등록. `ServerV1Routes`(SQLite)가 아님.
- 마이그레이션은 명시적 일회성 CLI. `--dry-run` 지원. server 미설정 시 비제로 종료.
- rename: `to` 미존재 → name UPDATE. `to` 존재 → 병합(참조 테이블의 `project_id`를 `to.id`로 재할당 후 `from` 삭제), 단일 트랜잭션.
- 테스트: `bun:test` (`import { describe, it, expect } from 'bun:test'`).

---

## File Structure
- `src/utils/project-name.ts` (수정) — `gitRemoteOriginUrl`, `parseOwnerRepo` 추가; `getProjectName` origin 기반; `getProjectContext` worktree 분기 제거.
- `src/storage/postgres/projects.ts` (수정) — `PostgresProjectsRepository.renameOrMerge`.
- `src/server/routes/v1/ServerV1PostgresRoutes.ts` (수정) — `POST /v1/projects/rename`.
- `src/services/hooks/server-beta-client.ts` (수정) — `renameProject`.
- `src/services/hooks/project-resolver.ts` (수정) — `applyRename` helper.
- `src/npx-cli/commands/project.ts` (신규) — `project migrate` 핸들러.
- `src/npx-cli/index.ts` (수정) — `case 'project'` 라우팅.

---

## Task 1: `parseOwnerRepo` (순수 파서)

**Files:**
- Modify: `src/utils/project-name.ts`
- Test: `tests/utils/parse-owner-repo.test.ts`

**Interfaces:**
- Produces: `export function parseOwnerRepo(url: string): string | null`

- [ ] **Step 1: 실패 테스트** — `tests/utils/parse-owner-repo.test.ts`
```ts
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
```

- [ ] **Step 2: 실패 확인** — Run: `bun test tests/utils/parse-owner-repo.test.ts` → FAIL (`parseOwnerRepo is not a function`).

- [ ] **Step 3: 구현** — `src/utils/project-name.ts`에 추가 (export):
```ts
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
```

- [ ] **Step 4: 통과 확인** — Run: `bun test tests/utils/parse-owner-repo.test.ts` → PASS. (실패 시 scp/url 분기를 위 케이스에 맞게 조정.)

- [ ] **Step 5: 커밋**
```bash
git add src/utils/project-name.ts tests/utils/parse-owner-repo.test.ts
git commit -m "feat(project-name): parseOwnerRepo — normalize git remote url to owner/repo"
```

---

## Task 2: `getProjectName` origin 기반 + worktree 통합

**Files:**
- Modify: `src/utils/project-name.ts`
- Test: `tests/utils/project-name-origin.test.ts`

**Interfaces:**
- Consumes: `parseOwnerRepo` (Task 1), 기존 `findGitRepoRoot`.
- Produces: `gitRemoteOriginUrl(repoRoot: string): string | null`; 변경된 `getProjectName`/`getProjectContext` 동작.

- [ ] **Step 1: 실패 테스트** — `tests/utils/project-name-origin.test.ts` (실제 임시 git repo 사용)
```ts
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
```

- [ ] **Step 2: 실패 확인** — Run: `bun test tests/utils/project-name-origin.test.ts` → FAIL (현재는 origin이어도 basename 반환).

- [ ] **Step 3: 구현** — `src/utils/project-name.ts`
`gitRemoteOriginUrl` 추가:
```ts
function gitRemoteOriginUrl(repoRoot: string): string | null {
  try {
    const url = execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return url || null;
  } catch { return null; }
}
```
`getProjectName`의 repoRoot 분기를 교체 — 기존:
```ts
  const repoRoot = findGitRepoRoot(expanded);
  const nameSource = repoRoot ?? expanded;
  const basename = path.basename(nameSource);
```
를 다음으로:
```ts
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
```
(이후의 빈 basename / Windows 드라이브 / 루트 fallback 블록은 그대로 유지.)

`getProjectContext`에서 worktree 분기 제거 — 본문을 다음으로 단순화:
```ts
export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const name = getProjectName(cwd);
  return { primary: name, parent: null, isWorktree: false, allProjects: [name] };
}
```
`detectWorktree` import 제거(`import { detectWorktree } from './worktree.js';` 삭제). `ProjectContext` 인터페이스는 호환을 위해 유지.

- [ ] **Step 4: 통과 확인**
Run: `bun test tests/utils/project-name-origin.test.ts` → PASS
Run: `bun test tests/utils/project-name.test.ts tests/utils/project-name-isolation.test.ts` → 기존 테스트 확인. worktree composite를 단언하던 기존 케이스가 있으면, 새 동작(owner/repo 통합)에 맞게 그 단언을 수정한다(삭제가 아니라 새 기대값으로). `npx tsc --noEmit`로 `worktree.ts` 미사용 import 오류가 없는지 확인.

- [ ] **Step 5: 커밋**
```bash
git add src/utils/project-name.ts tests/utils/project-name-origin.test.ts tests/utils/project-name.test.ts tests/utils/project-name-isolation.test.ts
git commit -m "feat(project-name): derive name from git origin owner/repo; fold worktrees in"
```

---

## Task 3: `PostgresProjectsRepository.renameOrMerge`

**Files:**
- Modify: `src/storage/postgres/projects.ts`
- Test: `tests/storage/projects-rename.test.ts`

**Interfaces:**
- Produces: `renameOrMerge(teamId: string, from: string, to: string): Promise<{ id: string; name: string; merged: boolean } | null>` (from 미존재 시 null).

- [ ] **Step 1: 병합 참조 테이블 확정** — `src/storage/postgres/schema.ts`에서 `project_id`로 `projects(id)`를 참조하는 모든 테이블을 grep으로 나열한다:
```bash
grep -nE "project_id" src/storage/postgres/schema.ts | grep -iE "REFERENCES projects|project_id (TEXT|UUID)"
```
나온 테이블 전부(예: `server_sessions`, `agent_events`, `observations`, `observation_generation_jobs`, `observation_sources` 등 실제 결과)를 merge UPDATE 대상으로 사용한다. **누락 금지** — 이 목록이 Step 3 구현의 테이블 집합이다.

- [ ] **Step 2: 실패 테스트** — `tests/storage/projects-rename.test.ts`. 기존 Postgres repo 테스트가 있으면 그 부트스트랩(테스트 pool/스키마)을 재사용한다. 없으면 `PostgresQueryable`를 구현한 인메모리 fake(쿼리 문자열→결과 매핑)로 호출 시퀀스를 검증한다:
```ts
import { describe, it, expect } from 'bun:test';
import { PostgresProjectsRepository } from '../../src/storage/postgres/projects.js';

// fake PostgresQueryable capturing queries; returns rows per scripted matcher
function fakeClient(script: Array<{ match: RegExp; rows: any[] }>) {
  const calls: { sql: string; params: any[] }[] = [];
  return {
    calls,
    async query(sql: string, params: any[] = []) {
      calls.push({ sql, params });
      const hit = script.find(s => s.match.test(sql));
      return { rows: hit ? hit.rows : [] };
    },
  };
}

describe('renameOrMerge', () => {
  it('returns null when from project does not exist', async () => {
    const c = fakeClient([{ match: /SELECT .*FROM projects WHERE/i, rows: [] }]);
    const repo = new PostgresProjectsRepository(c as any);
    expect(await repo.renameOrMerge('team1', 'old', 'new')).toBeNull();
  });
  it('renames when target name is free', async () => {
    const c = fakeClient([
      { match: /WHERE name = \$2/i, rows: [] }, // generic; refined below if needed
    ]);
    // Provide from-exists, to-absent via ordered behavior in implementation.
  });
});
```
(주의: fake로 분기 전부를 정밀 검증하기 어려우면, 최소한 (a) from-미존재 → null, (b) from-존재·to-미존재 → name UPDATE 쿼리 발생, (c) from-존재·to-존재 → 참조 UPDATE + from DELETE 쿼리들 발생을 `c.calls`의 SQL로 단언한다. 트랜잭션의 실제 원자성은 Postgres 통합/배포 검증에서 확인.)

- [ ] **Step 3: 실패 확인** — Run: `bun test tests/storage/projects-rename.test.ts` → FAIL.

- [ ] **Step 4: 구현** — `src/storage/postgres/projects.ts`의 `PostgresProjectsRepository`에 메서드 추가. `this.client.query`로 BEGIN/COMMIT 트랜잭션, Step 1에서 확정한 테이블 목록을 사용:
```ts
async renameOrMerge(teamId: string, from: string, to: string): Promise<{ id: string; name: string; merged: boolean } | null> {
  const fromRow = await queryOne<{ id: string }>(this.client,
    'SELECT id FROM projects WHERE team_id = $1 AND name = $2', [teamId, from]);
  if (!fromRow) return null;
  const toRow = await queryOne<{ id: string }>(this.client,
    'SELECT id FROM projects WHERE team_id = $1 AND name = $2', [teamId, to]);

  if (!toRow) {
    await queryOne(this.client,
      'UPDATE projects SET name = $1, updated_at = now() WHERE id = $2 RETURNING id',
      [to, fromRow.id]);
    return { id: fromRow.id, name: to, merged: false };
  }

  // merge: reassign every project_id reference, then delete the `from` project
  await this.client.query('BEGIN');
  try {
    // Step 1에서 확정한 테이블 전부에 대해:
    for (const table of ['server_sessions', 'agent_events', 'observations', /* …Step 1 결과… */]) {
      await this.client.query(
        `UPDATE ${table} SET project_id = $1 WHERE project_id = $2`, [toRow.id, fromRow.id]);
    }
    await this.client.query('DELETE FROM projects WHERE id = $1', [fromRow.id]);
    await this.client.query('COMMIT');
  } catch (e) {
    await this.client.query('ROLLBACK');
    throw e;
  }
  return { id: toRow.id, name: to, merged: true };
}
```
(테이블 배열은 Step 1 grep 결과로 하드코딩하되 주석으로 출처를 남긴다. `team_id`도 참조하는 복합 FK 테이블은 `WHERE project_id = $2 AND team_id = $3` 형태로 안전하게.)

- [ ] **Step 5: 통과 확인 + 커밋**
Run: `bun test tests/storage/projects-rename.test.ts` → PASS; `npx tsc --noEmit` clean.
```bash
git add src/storage/postgres/projects.ts tests/storage/projects-rename.test.ts
git commit -m "feat(projects): renameOrMerge — rename or merge a project by name"
```

---

## Task 4: `POST /v1/projects/rename` (ServerV1PostgresRoutes)

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts`
- Test: `tests/server/projects-rename-route.test.ts`

**Interfaces:**
- Consumes: `PostgresProjectsRepository.renameOrMerge` (Task 3), 기존 `writeAuth`/`handleCreate`/`requireTeamId`.
- Produces: `POST /v1/projects/rename` body `{ from, to }` → `{ id, name, merged }` (200) 또는 from 미존재 시 `{ renamed: false }` (200).

- [ ] **Step 1: 실패 테스트** — `tests/server/projects-rename-route.test.ts`. 기존 라우트 테스트(`tests/server/mcp-surface.test.ts` 등)의 app+auth 부트스트랩을 재사용해: (a) 인증된 `POST /v1/projects/rename {from,to}` → 200; (b) 무인증 → 401.

- [ ] **Step 2: 실패 확인** — Run: `bun test tests/server/projects-rename-route.test.ts` → FAIL (404).

- [ ] **Step 3: 구현** — `/v1/projects/resolve` 라우트(파일 내 ~499) 바로 옆에 추가. `resolve`와 동일한 패턴(`writeAuth`, `handleCreate`, `requireTeamId`, project-scoped 키 거부, `auditWrite`):
```ts
app.post('/v1/projects/rename', writeAuth, this.handleCreate(
  z.object({ from: z.string().min(1).max(200), to: z.string().min(1).max(200) }),
  async (req, res, body) => {
    const teamId = this.requireTeamId(req, res);
    if (!teamId) return;
    if (req.authContext?.projectId) {
      res.status(403).json({ error: 'Forbidden', message: 'project.rename requires a team-scoped api key' });
      return;
    }
    try {
      const repo = new PostgresProjectsRepository(this.options.pool);
      const result = await repo.renameOrMerge(teamId, body.from, body.to);
      if (!result) { res.status(200).json({ renamed: false }); return; }
      await this.auditWrite(req, 'project.rename', result.id, result.id, { from: body.from, to: body.to, merged: result.merged });
      res.status(200).json({ renamed: true, ...result });
    } catch (error) {
      this.handleDbError(error, res, 'project.rename');
    }
  },
));
```
`PostgresProjectsRepository` import가 파일에 없으면 추가.

- [ ] **Step 4: 통과 확인 + 커밋**
Run: `bun test tests/server/projects-rename-route.test.ts` → PASS; `npx tsc --noEmit` clean.
```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/projects-rename-route.test.ts
git commit -m "feat(server): POST /v1/projects/rename on the Postgres route module"
```

---

## Task 5: client `renameProject` + resolver `applyRename`

**Files:**
- Modify: `src/services/hooks/server-beta-client.ts`, `src/services/hooks/project-resolver.ts`
- Test: `tests/hooks/rename-project.test.ts`

**Interfaces:**
- Produces:
  - `ServerBetaClient.renameProject(from: string, to: string): Promise<{ renamed: boolean; id?: string; name?: string; merged?: boolean }>`
  - `ProjectResolver.applyRename(from: string, to: string, id: string): void` (cache에서 from 키 삭제, to→id 설정, persist)

- [ ] **Step 1: 실패 테스트** — `tests/hooks/rename-project.test.ts`: `ServerBetaClient`에 `fetchImpl` 주입(이전 작업에서 추가됨)해 `/v1/projects/rename` POST와 body `{from,to}` 검증; `ProjectResolver`에 임시 mapPath를 주고 `applyRename` 후 map 내용(`from` 없음, `to`→id) 단언.

- [ ] **Step 2: 실패 확인** — Run: `bun test tests/hooks/rename-project.test.ts` → FAIL.

- [ ] **Step 3: 구현**
`server-beta-client.ts`에 (다른 메서드 옆):
```ts
async renameProject(from: string, to: string): Promise<{ renamed: boolean; id?: string; name?: string; merged?: boolean }> {
  return this.request('POST', '/v1/projects/rename', { from, to });
}
```
`project-resolver.ts`에:
```ts
applyRename(from: string, to: string, id: string): void {
  delete this.cache[from];
  this.cache[to] = id;
  this.persist();
}
```
(`cache`/`persist`는 기존 private 멤버. `applyRename`은 public.)

- [ ] **Step 4: 통과 확인 + 커밋**
Run: `bun test tests/hooks/rename-project.test.ts` → PASS; `npx tsc --noEmit` clean.
```bash
git add src/services/hooks/server-beta-client.ts src/services/hooks/project-resolver.ts tests/hooks/rename-project.test.ts
git commit -m "feat(client): renameProject + ProjectResolver.applyRename"
```

---

## Task 6: `claude-mem project migrate` CLI

**Files:**
- Create: `src/npx-cli/commands/project.ts`
- Modify: `src/npx-cli/index.ts`
- Test: `tests/npx-cli/project-migrate.test.ts`

**Interfaces:**
- Consumes: `getProjectName` (Task 2), `ProjectResolver`/`ServerBetaClient` client context, `renameProject`/`applyRename` (Task 5).
- Produces: `runProjectCommand(argv: string[]): Promise<void>` (서브커맨드 `migrate`, 플래그 `--dry-run`).

- [ ] **Step 1: 실패 테스트** — `tests/npx-cli/project-migrate.test.ts`: 구→신 이름 계산 헬퍼를 단위로 검증한다. 핵심 순수 로직 `computeRename(cwd): { oldName, newName, changed }`를 export해서 테스트(`oldName`=폴더명 로직, `newName`=`getProjectName`); 임시 git repo(origin 설정)에서 `changed===true`이고 `newName==='owner/repo'`. `--dry-run` 경로는 server 호출 없이 출력만 함을 (client 미주입/모킹으로) 확인.

- [ ] **Step 2: 실패 확인** — Run: `bun test tests/npx-cli/project-migrate.test.ts` → FAIL.

- [ ] **Step 3: 구현** — `src/npx-cli/commands/project.ts`:
```ts
// SPDX-License-Identifier: Apache-2.0
import path from 'path';
import pc from 'picocolors';
import { execFileSync } from 'child_process';
import { getProjectName } from '../../utils/project-name.js';

// old (folder-name) logic: repo root basename if in a git repo, else cwd basename
function oldFolderName(cwd: string): string {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8', stdio: ['ignore','pipe','ignore'] }).trim();
    return path.basename(root || cwd);
  } catch { return path.basename(cwd); }
}

export function computeRename(cwd: string): { oldName: string; newName: string; changed: boolean } {
  const oldName = oldFolderName(cwd);
  const newName = getProjectName(cwd);
  return { oldName, newName, changed: oldName !== newName };
}

export async function runProjectCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== 'migrate') {
    console.error(pc.red('Usage: claude-mem project migrate [--dry-run]'));
    process.exit(1);
  }
  const dryRun = argv.includes('--dry-run');
  const cwd = process.cwd();
  const { oldName, newName, changed } = computeRename(cwd);
  if (!changed) { console.log(`No change: project is already "${newName}".`); return; }
  console.log(`${oldName}  →  ${newName}`);
  if (dryRun) { console.log('(dry-run: no changes sent)'); return; }

  const { buildClientRuntimeContext } = await import('../../services/hooks/runtime-selector.js');
  const ctx = buildClientRuntimeContext();
  if (!ctx) { console.error(pc.red('client runtime not configured (CLAUDE_MEM_SERVER_BETA_URL/API_KEY missing).')); process.exit(1); }
  const { ProjectResolver } = await import('../../services/hooks/project-resolver.js');
  const { DATA_DIR } = await import('../../shared/paths.js');
  const { join } = await import('path');
  const resolver = new ProjectResolver({ client: ctx.client, mapPath: join(DATA_DIR, 'project-map.json') });
  const result = await ctx.client.renameProject(oldName, newName);
  if (result.renamed && result.id) {
    resolver.applyRename(oldName, newName, result.id);
    console.log(pc.green(`Renamed${result.merged ? ' (merged into existing)' : ''}.`));
  } else {
    console.log('Nothing to rename on the server (no existing project by the old name).');
  }
}
```
(import 경로/`buildClientRuntimeContext`/`DATA_DIR`/`ProjectResolver` 생성 시그니처는 해당 파일들에서 실제 형태를 확인해 맞춘다 — `runtime.ts`의 기존 사용처가 참고.)

`src/npx-cli/index.ts`의 `switch (command)`에 추가:
```ts
    case 'project': {
      const { runProjectCommand } = await import('./commands/project.js');
      await runProjectCommand(argv.slice(1));
      break;
    }
```

- [ ] **Step 4: 통과 확인 + 커밋**
Run: `bun test tests/npx-cli/project-migrate.test.ts` → PASS; `npx tsc --noEmit` clean; `npm run build` exit 0.
```bash
git add src/npx-cli/commands/project.ts src/npx-cli/index.ts tests/npx-cli/project-migrate.test.ts plugin/ dist/
git commit -m "feat(cli): project migrate — rename folder-name project to owner/repo"
```

---

## Self-Review 결과
- **Spec coverage:** §4.1/4.2 핵심 로직→T1·T2, §4.4 rename/merge→T3, §4.3 라우트→T4, §4.5 client→T5, §4.6 CLI→T6, §6 에러처리는 각 task에 포함. 누락 없음.
- **Placeholder scan:** merge 테이블 목록은 T3 Step 1에서 schema로 확정(의도된 동적 단계). CLI import 시그니처는 "실제 형태 확인" 명시 — 알려진 1줄 확인 지점.
- **Type consistency:** `parseOwnerRepo(url): string|null`, `renameOrMerge(teamId,from,to)`, `renameProject(from,to)`, `applyRename(from,to,id)`, `computeRename(cwd)` — task 간 일관.
- **확인 항목(구현 중):** (a) 기존 worktree 단언 테스트의 기대값 갱신, (b) merge 참조 테이블 전수(T3 S1), (c) `ProjectResolver` 생성자/`buildClientRuntimeContext` 실제 시그니처.
