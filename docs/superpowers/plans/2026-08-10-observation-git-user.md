# Observation 작성자(git user) 기록·표시·필터 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Observation에 작성자(git user.name)를 기록하고, 제목이 표시되는 모든 지점에 `by <user>`로 노출하며, 작성자 기준으로 검색·컨텍스트 주입을 필터링할 수 있게 한다.

**Architecture:** 세션 시작 훅이 `git config user.name`을 1회 읽어 세션에 저장하고, Observation 생성 시 그 값을 복사한다. 로컬(sqlite)은 `sdk_sessions.git_user`(단일 진실 원천)와 `observations.git_user`(표시용 비정규화 사본) 두 컬럼을 쓰고, server-beta(postgres)는 title이 이미 들어 있는 `metadata` JSONB에 `gitUser`를 넣는다. 표시 문자열 결합은 표시 계층에서만 하고 API는 별도 필드로 내보낸다.

**Tech Stack:** TypeScript, Bun (`bun:sqlite`, `bun test`), Express, PostgreSQL(server-beta), React(뷰어 UI), zod

**설계 문서:** `docs/superpowers/specs/2026-08-10-observation-git-user-design.md`

## Global Constraints

- 저장 값은 `git config user.name` 하나다. email은 저장하지 않는다.
- 값 정규화: `trim()` → 개행/탭을 공백으로 치환 → 64자 절단. 결과가 빈 문자열이면 `null`.
- 표시 형식은 정확히 `by ${gitUser}, ${title}`. `gitUser`가 `null`이면 `title`만 출력한다.
- 컨텍스트 주입 필터 기본값은 `all`이며, **기존 사용자의 동작이 바뀌면 안 된다.**
- API 계층(`DataRoutes`, `ServerViewerDataRoutes`)은 title에 작성자를 합치지 않는다. 별도 필드로 내보내고 UI가 결합한다.
- `SessionSearch.buildFilterClause`는 `observations`와 `session_summaries` 양쪽에 쓰인다. `session_summaries`에는 `git_user` 컬럼이 없으므로 **직접 컬럼 비교를 쓰지 말고 세션 서브쿼리를 쓴다.**
- 기존 데이터 백필은 하지 않는다. `git_user`가 `NULL`인 행은 이름 없이 표시된다.
- 테스트는 `bun test`로 실행한다.
- 마이그레이션은 `PRAGMA table_info`로 컬럼 존재를 확인한 뒤 `ALTER TABLE ADD COLUMN` 하여 재실행이 멱등해야 한다.

## File Structure

**신규**
- `src/utils/git-user.ts` — git user 조회·정규화·캐시. 단일 책임.
- `src/shared/format-observation-title.ts` — 제목+작성자 결합 헬퍼. 표시 계층 전체가 공유.
- `tests/utils/git-user.test.ts`
- `tests/shared/format-observation-title.test.ts`
- `tests/context/observation-git-user-filter.test.ts`
- `tests/sqlite/git-user-search-filter.test.ts`

**수정**
- `src/services/sqlite/migrations/runner.ts` — 컬럼 추가 마이그레이션
- `src/cli/handlers/session-init.ts` — 캡처 및 두 런타임으로 전달
- `src/services/worker/http/routes/SessionRoutes.ts` — 스키마 + 핸들러
- `src/services/sqlite/sessions/create.ts` — `sdk_sessions` INSERT
- `src/services/worker/agents/ResponseProcessor.ts` — 관측에 작성자 부착
- `src/services/sqlite/SessionStore.ts` — 관측 INSERT (3곳) + 세션 생성 위임
- `src/services/sqlite/transactions.ts` — 관측 INSERT (2곳)
- `src/services/sqlite/observations/store.ts` — 관측 INSERT (1곳)
- `src/services/sqlite/types.ts` — `SearchFilters.gitUser`
- `src/services/sqlite/SessionSearch.ts` — 검색 필터
- `src/services/context/types.ts` — `Observation.git_user`, `ContextConfig.gitUserFilter`
- `src/services/context/ContextConfigLoader.ts` — 설정 로딩
- `src/services/context/ObservationCompiler.ts` — SELECT + 필터
- `src/services/context/formatters/HumanFormatter.ts`, `AgentFormatter.ts` — 표시
- `src/shared/SettingsDefaultsManager.ts` — 설정 키 기본값
- `src/cli/claude-md-commands.ts`, `src/cli/handlers/file-context.ts` — 표시
- `src/services/worker/search/ResultFormatter.ts`, `SearchManager.ts`, `TimelineService.ts` — 표시
- `src/services/integrations/TelegramNotifier.ts` — 표시
- `src/services/worker/http/routes/DataRoutes.ts` — API 필드
- `src/servers/mcp-server.ts` — MCP 도구 파라미터
- `src/ui/viewer/types.ts`, `src/ui/viewer/components/ObservationCard.tsx` — UI
- `src/server/generation/processGeneratedResponse.ts` — 서버 관측 metadata
- `src/server/runtime/ServerViewerDataRoutes.ts` — 서버 뷰어 API
- `src/storage/postgres/observations.ts` — 서버 검색 필터

---

### Task 1: git user 조회 유틸

**Files:**
- Create: `src/utils/git-user.ts`
- Test: `tests/utils/git-user.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `getGitUser(cwd: string | null | undefined): string | null`, `clearGitUserCache(): void`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/utils/git-user.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { getGitUser, clearGitUserCache } from '../../src/utils/git-user.js';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'gu-')); dirs.push(d); return d; }
function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}
afterEach(() => {
  clearGitUserCache();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('getGitUser', () => {
  it('repo-local user.name을 반환한다', () => {
    const d = tmp();
    git(d, 'init');
    git(d, 'config', 'user.name', 'medit-minheecho');
    expect(getGitUser(d)).toBe('medit-minheecho');
  });

  it('앞뒤 공백과 개행을 제거한다', () => {
    const d = tmp();
    git(d, 'init');
    git(d, 'config', 'user.name', '  superman  ');
    expect(getGitUser(d)).toBe('superman');
  });

  it('64자를 넘으면 절단한다', () => {
    const d = tmp();
    git(d, 'init');
    git(d, 'config', 'user.name', 'x'.repeat(100));
    expect(getGitUser(d)).toBe('x'.repeat(64));
  });

  it('존재하지 않는 디렉터리는 null을 반환한다', () => {
    expect(getGitUser('/nonexistent-path-for-test-12345')).toBeNull();
  });

  it('빈 cwd는 null을 반환한다', () => {
    expect(getGitUser('')).toBeNull();
    expect(getGitUser(null)).toBeNull();
    expect(getGitUser(undefined)).toBeNull();
  });

  it('같은 cwd를 두 번 호출하면 캐시된 값을 준다', () => {
    const d = tmp();
    git(d, 'init');
    git(d, 'config', 'user.name', 'first-name');
    expect(getGitUser(d)).toBe('first-name');
    git(d, 'config', 'user.name', 'second-name');
    expect(getGitUser(d)).toBe('first-name');
    clearGitUserCache();
    expect(getGitUser(d)).toBe('second-name');
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `bun test tests/utils/git-user.test.ts`
Expected: FAIL — `Cannot find module '../../src/utils/git-user.js'`

- [ ] **Step 3: 구현 작성**

`src/utils/git-user.ts`:

```typescript
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test tests/utils/git-user.test.ts`
Expected: PASS — 6 pass

- [ ] **Step 5: 커밋**

```bash
git add src/utils/git-user.ts tests/utils/git-user.test.ts
git commit -m "feat: git config user.name 조회 유틸 추가"
```

---

### Task 2: sqlite 스키마 마이그레이션

**Files:**
- Modify: `src/services/sqlite/migrations/runner.ts`
- Test: `tests/sqlite/git-user-migration.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `sdk_sessions.git_user TEXT`, `observations.git_user TEXT`, `idx_observations_git_user` 인덱스

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/sqlite/git-user-migration.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';

const dirs: string[] = [];
function tmpDb(): Database {
  const d = mkdtempSync(join(tmpdir(), 'gum-'));
  dirs.push(d);
  return new Database(join(d, 'test.db'));
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function columnNames(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
}

describe('git_user 마이그레이션', () => {
  it('observations와 sdk_sessions에 git_user 컬럼을 추가한다', () => {
    const db = tmpDb();
    new MigrationRunner(db).runAllMigrations();
    expect(columnNames(db, 'observations')).toContain('git_user');
    expect(columnNames(db, 'sdk_sessions')).toContain('git_user');
  });

  it('두 번 실행해도 실패하지 않는다', () => {
    const db = tmpDb();
    new MigrationRunner(db).runAllMigrations();
    expect(() => new MigrationRunner(db).runAllMigrations()).not.toThrow();
    expect(columnNames(db, 'observations').filter(c => c === 'git_user')).toHaveLength(1);
  });

  it('git_user 인덱스를 만든다', () => {
    const db = tmpDb();
    new MigrationRunner(db).runAllMigrations();
    const indexes = db.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='observations'"
    ).all() as Array<{ name: string }>;
    expect(indexes.map(i => i.name)).toContain('idx_observations_git_user');
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `bun test tests/sqlite/git-user-migration.test.ts`
Expected: FAIL — `expect(received).toContain("git_user")` 실패

- [ ] **Step 3: 마이그레이션 메서드 추가**

`src/services/sqlite/migrations/runner.ts`에 메서드를 추가한다. 기존 `addObservationSubagentColumns`(`:775`)와 같은 형태다:

```typescript
  private addGitUserColumns(): void {
    const obsCols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    if (!obsCols.some(c => c.name === 'git_user')) {
      this.db.run('ALTER TABLE observations ADD COLUMN git_user TEXT');
      logger.debug('DB', 'Added git_user column to observations table');
    }

    const sessionCols = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    if (sessionCols.length > 0 && !sessionCols.some(c => c.name === 'git_user')) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN git_user TEXT');
      logger.debug('DB', 'Added git_user column to sdk_sessions table');
    }

    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_git_user ON observations(git_user)');
  }
```

- [ ] **Step 4: 마이그레이션 실행 체인에 등록**

`runner.ts`에서 `addObservationSubagentColumns()`를 호출하는 지점을 찾아(`grep -n "addObservationSubagentColumns()" src/services/sqlite/migrations/runner.ts`) 그 **바로 다음 줄에** `this.addGitUserColumns();`를 추가한다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `bun test tests/sqlite/git-user-migration.test.ts`
Expected: PASS — 3 pass

- [ ] **Step 6: 기존 sqlite 테스트 회귀 확인**

Run: `bun test tests/sqlite/`
Expected: 기존과 동일하게 PASS (실패가 있으면 이 변경으로 생긴 것인지 확인)

- [ ] **Step 7: 커밋**

```bash
git add src/services/sqlite/migrations/runner.ts tests/sqlite/git-user-migration.test.ts
git commit -m "feat: observations/sdk_sessions에 git_user 컬럼 추가"
```

---

### Task 3: 훅에서 캡처하여 세션에 저장 (로컬 worker)

**Files:**
- Modify: `src/cli/handlers/session-init.ts`
- Modify: `src/services/worker/http/routes/SessionRoutes.ts:179-185`, `:311-318`, `:352`
- Modify: `src/services/sqlite/SessionStore.ts:1660-1720` (**실제 런타임 경로**)
- Modify: `src/services/sqlite/sessions/create.ts:16-23`, `:67-71` (중복 구현, 일관성 유지)
- Test: `tests/hooks/session-init-git-user.test.ts`

**주의:** `createSDKSession`은 두 곳에 **중복 구현**되어 있다. `SessionStore.ts:1660`의 메서드와 `sessions/create.ts:16`의 함수가 거의 같은 코드다. `SessionRoutes`가 호출하는 것은 `store.createSDKSession`, 즉 **SessionStore 쪽이 실제로 동작하는 경로**다. 둘 다 고치되 테스트는 SessionStore를 대상으로 한다.

**Interfaces:**
- Consumes: `getGitUser(cwd)` (Task 1), `sdk_sessions.git_user` 컬럼 (Task 2)
- Produces: `/api/sessions/init` 요청 body의 `gitUser?: string` 필드, `sdk_sessions.git_user`에 저장된 값

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/hooks/session-init-git-user.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { createSDKSession } from '../../src/services/sqlite/sessions/create.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const dirs: string[] = [];
function tmpDb(): Database {
  const d = mkdtempSync(join(tmpdir(), 'sigu-'));
  dirs.push(d);
  const db = new Database(join(d, 'test.db'));
  new MigrationRunner(db).runAllMigrations();
  return db;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('세션 생성 시 git_user 저장', () => {
  // SessionRoutes가 실제로 호출하는 경로.
  it('SessionStore가 gitUser를 sdk_sessions에 기록한다', () => {
    const db = tmpDb();
    const store = new SessionStore(db);
    store.createSDKSession('sess-1', 'acme/widget', 'hello', undefined, 'claude', 'bjlee2024');
    const row = db.query('SELECT git_user FROM sdk_sessions WHERE content_session_id = ?')
      .get('sess-1') as { git_user: string | null };
    expect(row.git_user).toBe('bjlee2024');
  });

  it('gitUser가 없으면 NULL로 남는다', () => {
    const db = tmpDb();
    const store = new SessionStore(db);
    store.createSDKSession('sess-2', 'acme/widget', 'hello', undefined, 'claude');
    const row = db.query('SELECT git_user FROM sdk_sessions WHERE content_session_id = ?')
      .get('sess-2') as { git_user: string | null };
    expect(row.git_user).toBeNull();
  });

  // 중복 구현도 같은 동작이어야 한다.
  it('sessions/create.ts의 함수도 gitUser를 기록한다', () => {
    const db = tmpDb();
    createSDKSession(db, 'sess-3', 'acme/widget', 'hello', undefined, 'claude', 'superman');
    const row = db.query('SELECT git_user FROM sdk_sessions WHERE content_session_id = ?')
      .get('sess-3') as { git_user: string | null };
    expect(row.git_user).toBe('superman');
  });
});
```

`SessionStore`의 생성자는 `Database` 인스턴스를 그대로 받는다(`SessionStore.ts:32`).

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `bun test tests/hooks/session-init-git-user.test.ts`
Expected: FAIL — `expect(received).toBe("bjlee2024")`, received `null`

- [ ] **Step 3: 세션 INSERT에 컬럼 추가**

`src/services/sqlite/sessions/create.ts`의 `createSDKSession` 시그니처(`:16-23`)에 7번째 위치 인자를 추가한다. 기존 호출자는 6개 인자만 넘기므로 optional이어야 한다:

```typescript
export function createSDKSession(
  db: Database,
  contentSessionId: string,
  project: string,
  userPrompt: string,
  customTitle?: string,
  platformSource?: string,
  gitUser?: string | null
): number {
```

같은 파일의 INSERT(`:67-71`)를 수정한다. 기존:

```typescript
  db.prepare(`
    INSERT INTO sdk_sessions
    (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
  `).run(contentSessionId, project, normalizedPlatformSource, userPrompt, resolved.customTitle || null, now.toISOString(), nowEpoch);
```

변경 후:

```typescript
  db.prepare(`
    INSERT INTO sdk_sessions
    (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, git_user, started_at, started_at_epoch, status)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(contentSessionId, project, normalizedPlatformSource, userPrompt, resolved.customTitle || null, gitUser ?? null, now.toISOString(), nowEpoch);
```

이 함수는 이미 존재하는 세션이면 조기 반환한다(`:30` 부근의 `if (existing)` 블록). 재개된 세션에는 작성자가 채워지지 않는데, 세션을 처음 만든 사람이 그 세션의 작성자이므로 의도한 동작이다.

- [ ] **Step 3b: SessionStore의 중복 구현에 동일 적용 (실제 런타임 경로)**

`src/services/sqlite/SessionStore.ts:1660`의 `createSDKSession` 메서드에 같은 수정을 한다. 시그니처(`:1660-1666`):

```typescript
  createSDKSession(
    contentSessionId: string,
    project: string,
    userPrompt: string,
    customTitle?: string,
    platformSource?: string,
    gitUser?: string | null
  ): number {
```

INSERT(`:1710-1714`):

```typescript
    this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, git_user, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(contentSessionId, project, normalizedPlatformSource, userPrompt, resolved.customTitle || null, gitUser ?? null, now.toISOString(), nowEpoch);
```

`SessionRoutes.ts`와 `src/services/worker/http/shared.ts`에는 이 메서드의 호출부가 6곳 있는데, `gitUser`가 optional이라 나머지는 수정 없이 그대로 컴파일된다.

- [ ] **Step 4: 라우트 스키마와 핸들러 수정**

`src/services/worker/http/routes/SessionRoutes.ts:179-185`:

```typescript
  private static readonly sessionInitByClaudeIdSchema = z.object({
    contentSessionId: z.string().min(1),
    project: z.string().optional(),
    prompt: z.string().optional(),
    platformSource: z.string().optional(),
    customTitle: z.string().optional(),
    gitUser: z.string().optional(),
  }).passthrough();
```

`handleSessionInitByClaudeId`(`:311`)에서 `customTitle`을 꺼내는 줄 아래에 추가:

```typescript
    const gitUser = typeof req.body.gitUser === 'string' && req.body.gitUser.trim() !== ''
      ? req.body.gitUser
      : null;
```

같은 핸들러 안의 세션 생성 호출(`:352`)을 수정한다. 기존:

```typescript
    const sessionDbId = store.createSDKSession(contentSessionId, project, prompt, customTitle, platformSource);
```

변경 후:

```typescript
    const sessionDbId = store.createSDKSession(contentSessionId, project, prompt, customTitle, platformSource, gitUser);
```

- [ ] **Step 5: 훅에서 캡처하여 전송**

`src/cli/handlers/session-init.ts` 상단 import에 추가:

```typescript
import { getGitUser } from '../../utils/git-user.js';
```

`const project = getProjectContext(cwd).primary;` 바로 아래에 추가:

```typescript
    const gitUser = getGitUser(cwd);
```

`/api/sessions/init` 호출 body에 `gitUser`를 추가한다:

```typescript
      {
        contentSessionId: sessionId,
        project,
        prompt,
        platformSource,
        gitUser,
      },
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `bun test tests/hooks/session-init-git-user.test.ts`
Expected: PASS — 2 pass

- [ ] **Step 7: 커밋**

```bash
git add src/cli/handlers/session-init.ts src/services/worker/http/routes/SessionRoutes.ts src/services/sqlite/sessions/create.ts src/services/sqlite/SessionStore.ts tests/hooks/session-init-git-user.test.ts
git commit -m "feat: 세션 시작 시 git user를 캡처해 sdk_sessions에 저장"
```

---

### Task 4: Observation에 작성자 복사 (로컬 worker)

**Files:**
- Modify: `src/services/worker/agents/ResponseProcessor.ts:144-148`
- Modify: `src/services/sqlite/SessionStore.ts:1774`, `:1902`, `:2020`
- Modify: `src/services/sqlite/transactions.ts:34`, `:140`
- Modify: `src/services/sqlite/observations/store.ts:36`
- Test: `tests/sqlite/observation-git-user-store.test.ts`

**Interfaces:**
- Consumes: `sdk_sessions.git_user` (Task 3), `observations.git_user` 컬럼 (Task 2)
- Produces: `ObservationInput.git_user?: string | null` 필드가 관측 INSERT 경로 전반에서 통용됨

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/sqlite/observation-git-user-store.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { storeObservation } from '../../src/services/sqlite/observations/store.js';

const dirs: string[] = [];
function tmpDb(): Database {
  const d = mkdtempSync(join(tmpdir(), 'ogu-'));
  dirs.push(d);
  const db = new Database(join(d, 'test.db'));
  new MigrationRunner(db).runAllMigrations();
  db.run(
    "INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES ('c1', 'm1', 'acme/widget', '2026-08-10T00:00:00Z', 0, 'active')"
  );
  return db;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const baseObs = {
  type: 'discovery',
  title: 'NPM Registry Latest Version',
  subtitle: null,
  facts: [],
  narrative: 'n',
  concepts: [],
  files_read: [],
  files_modified: [],
};

describe('storeObservation git_user', () => {
  it('git_user를 저장한다', () => {
    const db = tmpDb();
    const { id } = storeObservation(db, 'm1', 'acme/widget', { ...baseObs, git_user: 'bjlee2024' });
    const row = db.query('SELECT git_user FROM observations WHERE id = ?').get(id) as { git_user: string | null };
    expect(row.git_user).toBe('bjlee2024');
  });

  it('git_user가 없으면 NULL로 저장한다', () => {
    const db = tmpDb();
    const { id } = storeObservation(db, 'm1', 'acme/widget', { ...baseObs, title: 'other' });
    const row = db.query('SELECT git_user FROM observations WHERE id = ?').get(id) as { git_user: string | null };
    expect(row.git_user).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `bun test tests/sqlite/observation-git-user-store.test.ts`
Expected: FAIL — `no such column: git_user` 또는 `expect(received).toBe("bjlee2024")`

- [ ] **Step 3: ObservationInput 타입에 필드 추가**

`src/services/sqlite/observations/types.ts`의 `ObservationInput`에 추가:

```typescript
  git_user?: string | null;
```

- [ ] **Step 4: `observations/store.ts`의 INSERT 수정**

`src/services/sqlite/observations/store.ts:35-62`. 컬럼 목록에 `git_user`를, VALUES에 `?` 하나를, 인자 목록의 `observation.agent_id ?? null` 다음에 `observation.git_user ?? null`을 추가한다:

```typescript
  const stmt = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
     files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, git_user, content_hash, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_session_id, content_hash) DO NOTHING
    RETURNING id, created_at_epoch
  `);

  const inserted = stmt.get(
    memorySessionId,
    resolvedProject,
    observation.type,
    observation.title,
    observation.subtitle,
    JSON.stringify(observation.facts),
    observation.narrative,
    JSON.stringify(observation.concepts),
    JSON.stringify(observation.files_read),
    JSON.stringify(observation.files_modified),
    promptNumber || null,
    discoveryTokens,
    observation.agent_type ?? null,
    observation.agent_id ?? null,
    observation.git_user ?? null,
    contentHash,
    timestampIso,
    timestampEpoch
  ) as { id: number; created_at_epoch: number } | null;
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `bun test tests/sqlite/observation-git-user-store.test.ts`
Expected: PASS — 2 pass

- [ ] **Step 6: 나머지 INSERT 경로 5곳에 동일 적용**

아래 각 위치에서 **똑같은 3가지 수정**을 한다 — 컬럼 목록에 `git_user` 추가, VALUES에 `?` 하나 추가, 인자 목록의 `agent_id` 다음에 `observation.git_user ?? null` 추가:

1. `src/services/sqlite/transactions.ts:34` (`storeObservationsAndMarkComplete`)
2. `src/services/sqlite/transactions.ts:140` (`storeObservations`)
3. `src/services/sqlite/SessionStore.ts:1774` (`storeObservation`)
4. `src/services/sqlite/SessionStore.ts:1902` (`storeObservations`)
5. `src/services/sqlite/SessionStore.ts:2020` (`storeObservationsAndMarkComplete`)

`SessionStore.ts`의 세 메서드는 각각 인라인 타입으로 관측 배열을 받는다(`:1869-1880` 형태). 각 인라인 타입의 `agent_id?: string | null;` 다음 줄에 `git_user?: string | null;`을 추가한다.

`src/services/sqlite/import/bulk.ts:147`은 외부 데이터 import 경로이므로 이번 범위에서 제외한다.

- [ ] **Step 7: 관측에 세션의 작성자 부착**

`src/services/worker/agents/ResponseProcessor.ts:144-148`:

```typescript
  const labeledObservations = observations.map(obs => ({
    ...obs,
    agent_type: session.pendingAgentType ?? null,
    agent_id: session.pendingAgentId ?? null,
    git_user: session.gitUser ?? null
  }));
```

`session` 객체에 `gitUser` 필드가 없으므로, 세션 객체를 만드는 `src/services/worker/SessionManager.ts`에서 `pendingAgentType: null`을 초기화하는 지점(`:128`) 근처에 `gitUser`를 추가하고, DB의 `sdk_sessions.git_user`를 읽어 채운다. 세션을 DB에서 복원하는 SELECT에도 `git_user`를 포함시켜야 한다.

- [ ] **Step 8: 전체 sqlite·worker 테스트 회귀 확인**

Run: `bun test tests/sqlite/`
Expected: PASS

Run: `bun test tests/worker/`
Expected: PASS

- [ ] **Step 9: 커밋**

```bash
git add src/services/sqlite/ src/services/worker/agents/ResponseProcessor.ts src/services/worker/SessionManager.ts tests/sqlite/observation-git-user-store.test.ts
git commit -m "feat: Observation 저장 시 세션의 git user를 복사"
```

---

### Task 5: 표시 헬퍼와 컨텍스트 주입 포맷터

**Files:**
- Create: `src/shared/format-observation-title.ts`
- Test: `tests/shared/format-observation-title.test.ts`
- Modify: `src/services/context/types.ts:31-45`
- Modify: `src/services/context/ObservationCompiler.ts:28-53`, `:88` 이하
- Modify: `src/services/context/formatters/HumanFormatter.ts:109`, `:128`
- Modify: `src/services/context/formatters/AgentFormatter.ts:95`, `:109`

**Interfaces:**
- Consumes: `observations.git_user` (Task 4)
- Produces: `formatObservationTitle(title: string | null, gitUser: string | null | undefined): string`, `Observation.git_user?: string | null`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/shared/format-observation-title.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { formatObservationTitle } from '../../src/shared/format-observation-title.js';

describe('formatObservationTitle', () => {
  it('작성자가 있으면 "by <user>, <title>" 형태로 만든다', () => {
    expect(formatObservationTitle('NPM Registry Latest Version', 'bjlee2024'))
      .toBe('by bjlee2024, NPM Registry Latest Version');
  });

  it('작성자가 없으면 제목만 반환한다', () => {
    expect(formatObservationTitle('Version Bump Implemented', null))
      .toBe('Version Bump Implemented');
    expect(formatObservationTitle('Version Bump Implemented', undefined))
      .toBe('Version Bump Implemented');
  });

  it('작성자가 빈 문자열이면 제목만 반환한다', () => {
    expect(formatObservationTitle('Some Title', '')).toBe('Some Title');
    expect(formatObservationTitle('Some Title', '   ')).toBe('Some Title');
  });

  it('제목이 없으면 Untitled로 대체한다', () => {
    expect(formatObservationTitle(null, 'superman')).toBe('by superman, Untitled');
    expect(formatObservationTitle(null, null)).toBe('Untitled');
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `bun test tests/shared/format-observation-title.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/format-observation-title.js'`

- [ ] **Step 3: 헬퍼 구현**

`src/shared/format-observation-title.ts`:

```typescript
/**
 * Observation 제목 앞에 작성자를 붙인다. 표시 계층 전용 — 저장되는 title은
 * 절대 이 함수를 거친 값이 되어서는 안 된다(검색 인덱스와 임베딩이 오염된다).
 */
export function formatObservationTitle(
  title: string | null | undefined,
  gitUser: string | null | undefined
): string {
  const resolvedTitle = title && title.trim() !== '' ? title : 'Untitled';
  if (!gitUser || gitUser.trim() === '') return resolvedTitle;
  return `by ${gitUser}, ${resolvedTitle}`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test tests/shared/format-observation-title.test.ts`
Expected: PASS — 4 pass

- [ ] **Step 5: Observation 타입에 필드 추가**

`src/services/context/types.ts`의 `Observation` 인터페이스(`:31`)에서 `platform_source?: string;` 다음 줄에 추가:

```typescript
  git_user?: string | null;
```

- [ ] **Step 6: 컨텍스트 쿼리가 git_user를 읽도록 수정**

`src/services/context/ObservationCompiler.ts`의 `queryObservations`(`:28`) SELECT 목록에서 `o.discovery_tokens,` 다음 줄에 추가:

```sql
      o.git_user,
```

`queryObservationsMulti`(`:88`)의 SELECT에도 동일하게 추가한다.

- [ ] **Step 7: 컨텍스트 포맷터에 적용**

`src/services/context/formatters/HumanFormatter.ts` 상단 import에 추가:

```typescript
import { formatObservationTitle } from '../../../shared/format-observation-title.js';
```

`renderHumanTableRow`(`:109`)와 `renderHumanFullObservation`(`:128`)의 다음 줄을

```typescript
  const title = obs.title || 'Untitled';
```

이렇게 바꾼다:

```typescript
  const title = formatObservationTitle(obs.title, obs.git_user);
```

`src/services/context/formatters/AgentFormatter.ts`도 동일하게 import를 추가하고 `:95`, `:109` 두 곳을 같은 방식으로 바꾼다.

- [ ] **Step 8: 컨텍스트 테스트 회귀 확인**

Run: `bun test tests/context/`
Expected: PASS

- [ ] **Step 9: 커밋**

```bash
git add src/shared/format-observation-title.ts src/services/context/ tests/shared/format-observation-title.test.ts
git commit -m "feat: 컨텍스트 주입 제목에 작성자 표시"
```

---

### Task 6: 나머지 표시 지점 (CLI·검색·타임라인·알림)

**Files:**
- Modify: `src/cli/claude-md-commands.ts:224`
- Modify: `src/cli/handlers/file-context.ts:129`
- Modify: `src/services/worker/search/ResultFormatter.ts:140`, `:192`
- Modify: `src/services/worker/SearchManager.ts:675`, `:1209`, `:1412`, `:1516`, `:1645`
- Modify: `src/services/worker/TimelineService.ts:169`
- Modify: `src/services/integrations/TelegramNotifier.ts:41`

**Interfaces:**
- Consumes: `formatObservationTitle` (Task 5)
- Produces: 없음 (표시 전용)

- [ ] **Step 1: 각 파일에 import 추가**

각 파일 상단에 상대 경로에 맞춰 import를 추가한다. 예를 들어 `src/services/worker/SearchManager.ts`는:

```typescript
import { formatObservationTitle } from '../../shared/format-observation-title.js';
```

`src/cli/claude-md-commands.ts`는:

```typescript
import { formatObservationTitle } from '../shared/format-observation-title.js';
```

- [ ] **Step 2: `const title = obs.title || 'Untitled'` 패턴을 모두 치환**

아래 위치에서 `obs.title || 'Untitled'`(또는 `obs.title || '(untitled)'`, `obs.title || \`Observation #${obs.id}\``) 형태를 `formatObservationTitle(obs.title, obs.git_user)`로 바꾼다:

- `src/services/worker/search/ResultFormatter.ts:140`, `:192`
- `src/services/worker/SearchManager.ts:675`, `:1412`, `:1516`, `:1645`
- `src/services/worker/TimelineService.ts:169`
- `src/cli/claude-md-commands.ts:224`

`SearchManager.ts:1209`는 다음 형태다:

```typescript
            lines.push(`- ${obs.title}`);
```

이렇게 바꾼다:

```typescript
            lines.push(`- ${formatObservationTitle(obs.title, obs.git_user)}`);
```

- [ ] **Step 3: file-context 적용**

`src/cli/handlers/file-context.ts:129`는 제목을 정제하는 코드다. 기존:

```typescript
      const title = (obs.title || 'Untitled').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
```

변경 후:

```typescript
      const title = formatObservationTitle(obs.title, obs.git_user).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
```

- [ ] **Step 4: Telegram 알림 적용**

`src/services/integrations/TelegramNotifier.ts:41`. 기존:

```typescript
  const title = escapeMarkdownV2(obs.title ?? '');
```

변경 후:

```typescript
  const title = escapeMarkdownV2(formatObservationTitle(obs.title, obs.git_user));
```

- [ ] **Step 5: 타입 오류 확인**

Run: `npx tsc --noEmit`
Expected: `git_user` 관련 타입 오류 없음. 오류가 나는 타입에는 `git_user?: string | null;`을 추가한다 (검색 결과 타입은 `src/services/sqlite/types.ts`의 `ObservationRow`).

- [ ] **Step 6: 검색·타임라인 테스트 회귀 확인**

Run: `bun test tests/worker/search/`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add src/cli/ src/services/worker/ src/services/integrations/TelegramNotifier.ts
git commit -m "feat: 검색·타임라인·CLI·알림 제목에 작성자 표시"
```

---

### Task 7: API 필드와 뷰어 UI

**Files:**
- Modify: `src/services/worker/http/routes/DataRoutes.ts:369`
- Modify: `src/ui/viewer/types.ts:1-19`
- Modify: `src/ui/viewer/components/ObservationCard.tsx:95`
- Test: `tests/viewer/observation-card-git-user.test.tsx`

**Interfaces:**
- Consumes: `observations.git_user` (Task 4), `formatObservationTitle` (Task 5)
- Produces: API 응답의 `git_user` 필드, UI Observation 타입의 `git_user`

- [ ] **Step 1: 뷰어 Observation 타입에 필드 추가**

`src/ui/viewer/types.ts`의 `Observation` 인터페이스에서 `platform_source: string;` 다음 줄에 추가:

```typescript
  git_user?: string | null;
```

- [ ] **Step 2: API가 필드를 내보내도록 수정**

`src/services/worker/http/routes/DataRoutes.ts:369` 부근의 응답 객체에서 `title: obs.title || null,` 다음 줄에 추가:

```typescript
            git_user: obs.git_user ?? null,
```

**title에 작성자를 합치지 않는다.** 이 API는 데이터 전달용이고 결합은 UI 책임이다.

- [ ] **Step 3: 실패하는 UI 테스트 작성**

`tests/viewer/observation-card-git-user.test.tsx`:

```tsx
import { describe, it, expect } from 'bun:test';
import { formatObservationTitle } from '../../src/shared/format-observation-title.js';

describe('ObservationCard 제목 결합', () => {
  it('git_user가 있으면 by 접두어가 붙는다', () => {
    expect(formatObservationTitle('Version Bump Implemented', 'medit-minheecho'))
      .toBe('by medit-minheecho, Version Bump Implemented');
  });

  it('git_user가 없으면 제목만 나온다', () => {
    expect(formatObservationTitle('Version Bump Implemented', null))
      .toBe('Version Bump Implemented');
  });
});
```

`tests/viewer/`에 이미 React 컴포넌트를 렌더링하는 테스트 설정이 있으면(`ls tests/viewer/`로 확인) 그 패턴을 따라 `ObservationCard`를 직접 렌더링해 텍스트를 검증하는 편이 낫다. 렌더링 설정이 없다면 위처럼 결합 규칙만 검증하고, 컴포넌트 수정은 Step 4의 시각 확인으로 대신한다.

- [ ] **Step 4: 카드 컴포넌트 수정**

`src/ui/viewer/components/ObservationCard.tsx` 상단 import에 추가:

```tsx
import { formatObservationTitle } from '../../../shared/format-observation-title.js';
```

`:95`를 다음과 같이 바꾼다:

```tsx
      <div className="card-title">{formatObservationTitle(observation.title, observation.git_user)}</div>
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `bun test tests/viewer/`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src/services/worker/http/routes/DataRoutes.ts src/ui/viewer/ tests/viewer/observation-card-git-user.test.tsx
git commit -m "feat: 뷰어 API와 카드에 작성자 노출"
```

---

### Task 8: 작성자 기준 검색 필터 (로컬)

**Files:**
- Modify: `src/services/sqlite/types.ts:237-244`
- Modify: `src/services/sqlite/SessionSearch.ts:150-175`
- Modify: `src/servers/mcp-server.ts:514-530`
- Test: `tests/sqlite/git-user-search-filter.test.ts`

**Interfaces:**
- Consumes: `sdk_sessions.git_user` (Task 3)
- Produces: `SearchFilters.gitUser?: string`, MCP `search` 도구의 `gitUser` 파라미터

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/sqlite/git-user-search-filter.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';

const dirs: string[] = [];
function tmpDb(): Database {
  const d = mkdtempSync(join(tmpdir(), 'gusf-'));
  dirs.push(d);
  const db = new Database(join(d, 'test.db'));
  new MigrationRunner(db).runAllMigrations();

  db.run("INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, git_user, started_at, started_at_epoch, status) VALUES ('c1','m1','acme/widget','bjlee2024','2026-08-10T00:00:00Z',0,'active')");
  db.run("INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, git_user, started_at, started_at_epoch, status) VALUES ('c2','m2','acme/widget','superman','2026-08-10T00:00:00Z',0,'active')");

  const insertObs = (mid: string, title: string, user: string) => {
    db.run(
      "INSERT INTO observations (memory_session_id, project, type, title, narrative, facts, concepts, files_read, files_modified, git_user, content_hash, created_at, created_at_epoch) VALUES (?,?,?,?,?,'[]','[]','[]','[]',?,?, '2026-08-10T00:00:00Z', 0)",
      [mid, 'acme/widget', 'discovery', title, 'deployment narrative', user, `${mid}-${title}`]
    );
  };
  insertObs('m1', 'deployment by first user', 'bjlee2024');
  insertObs('m2', 'deployment by second user', 'superman');
  return db;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('gitUser 검색 필터', () => {
  it('지정한 작성자의 관측만 반환한다', () => {
    const db = tmpDb();
    const search = new SessionSearch(db);
    const results = search.searchObservations('deployment', { gitUser: 'bjlee2024' });
    expect(results.length).toBe(1);
    expect(results[0]!.git_user).toBe('bjlee2024');
  });

  it('필터가 없으면 전원을 반환한다', () => {
    const db = tmpDb();
    const search = new SessionSearch(db);
    const results = search.searchObservations('deployment', {});
    expect(results.length).toBe(2);
  });

  it('session_summaries 검색에서도 SQL 에러가 나지 않는다', () => {
    const db = tmpDb();
    const search = new SessionSearch(db);
    // session_summaries에는 git_user 컬럼이 없다. 세션 서브쿼리를 쓰지 않으면
    // 여기서 "no such column: git_user"로 터진다.
    expect(() => search.searchSessions('deployment', { gitUser: 'bjlee2024' })).not.toThrow();
  });
});
```

`SessionSearch`의 생성자는 `Database` 인스턴스를 직접 받는다(`SessionSearch.ts:23`). 관측 검색은 `searchObservations(query, options)`(`:244`), 요약 검색은 `searchSessions(query, options)`(`:298`)다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `bun test tests/sqlite/git-user-search-filter.test.ts`
Expected: FAIL — 필터가 무시되어 첫 테스트가 `expect(1).toBe(1)` 대신 2건을 받는다

- [ ] **Step 3: SearchFilters 타입 확장**

`src/services/sqlite/types.ts:237`:

```typescript
export interface SearchFilters {
  project?: string;
  platformSource?: string;
  gitUser?: string;
  type?: ObservationRow['type'] | ObservationRow['type'][];
  concepts?: string | string[];
  files?: string | string[];
  dateRange?: DateRange;
}
```

같은 파일의 `ObservationRow`에도 `git_user?: string | null;`을 추가한다.

- [ ] **Step 4: 필터 절 구현**

`src/services/sqlite/SessionSearch.ts`의 `buildFilterClause`에서 `platformSource` 블록 바로 다음에 추가한다:

```typescript
    // 작성자 스코핑: buildFilterClause는 observations와 session_summaries 양쪽에
    // 쓰이는데 session_summaries에는 git_user 컬럼이 없다. platformSource와 같은
    // 이유로 직접 컬럼 비교 대신 memory_session_id 기반 세션 서브쿼리를 쓴다.
    if (filters.gitUser) {
      conditions.push(
        `(SELECT s3.git_user FROM sdk_sessions s3 WHERE s3.memory_session_id = ${tableAlias}.memory_session_id) = ?`
      );
      params.push(filters.gitUser);
    }
```

서브쿼리 별칭은 `platformSource`가 쓰는 `s2`와 겹치지 않도록 `s3`로 둔다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `bun test tests/sqlite/git-user-search-filter.test.ts`
Expected: PASS — 3 pass

- [ ] **Step 6: MCP 도구에 파라미터 노출**

`src/servers/mcp-server.ts:514`의 `search` 도구에서 description을 갱신하고 `platformSource` 다음에 속성을 추가한다:

```typescript
    description: 'Step 1: Search memory. Returns index with IDs. Params: query, limit, project, platformSource, gitUser, type, obs_type, dateStart, dateEnd, offset, orderBy',
```

```typescript
        gitUser: { type: 'string', description: "Filter by git author (git config user.name) — restricts results to that person's observations" },
```

worker 모드는 `callWorkerAPI(endpoint, args)`로 args를 그대로 전달하므로 추가 배선이 필요 없다. 워커 검색 라우트가 `gitUser`를 `SearchFilters`로 넘기는지 확인하고, 누락되어 있으면 `platformSource`를 넘기는 지점 옆에 추가한다.

- [ ] **Step 7: 커밋**

```bash
git add src/services/sqlite/ src/servers/mcp-server.ts tests/sqlite/git-user-search-filter.test.ts
git commit -m "feat: 작성자 기준 검색 필터 추가"
```

---

### Task 9: 컨텍스트 주입 작성자 필터 설정

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts:34`, `:123` 부근
- Modify: `src/services/context/types.ts:13-29`
- Modify: `src/services/context/ContextConfigLoader.ts:15-28`
- Modify: `src/services/context/ObservationCompiler.ts`
- Modify: `src/services/context/formatters/HumanFormatter.ts:24-31`
- Test: `tests/context/observation-git-user-filter.test.ts`

**Interfaces:**
- Consumes: `getGitUser` (Task 1), `observations.git_user` (Task 4), `ContextConfig` (Task 5)
- Produces: `ContextConfig.gitUserFilter: string | null`, 설정 키 `CLAUDE_MEM_CONTEXT_GIT_USER`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/context/observation-git-user-filter.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { resolveGitUserFilter } from '../../src/services/context/ContextConfigLoader.js';

describe('resolveGitUserFilter', () => {
  it('all이면 null(필터 없음)을 준다', () => {
    expect(resolveGitUserFilter('all', () => 'bjlee2024')).toBeNull();
  });

  it('설정이 비어 있으면 null을 준다', () => {
    expect(resolveGitUserFilter('', () => 'bjlee2024')).toBeNull();
  });

  it('me면 현재 git user로 해석한다', () => {
    expect(resolveGitUserFilter('me', () => 'bjlee2024')).toBe('bjlee2024');
  });

  it('me인데 git user를 못 읽으면 전원으로 폴백한다', () => {
    expect(resolveGitUserFilter('me', () => null)).toBeNull();
  });

  it('구체적 이름이면 그 이름으로 필터한다', () => {
    expect(resolveGitUserFilter('superman', () => 'bjlee2024')).toBe('superman');
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `bun test tests/context/observation-git-user-filter.test.ts`
Expected: FAIL — `resolveGitUserFilter is not a function`

- [ ] **Step 3: 설정 기본값 추가**

`src/shared/SettingsDefaultsManager.ts`의 인터페이스에 `CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: string;` 근처(`:34`)에 추가:

```typescript
  CLAUDE_MEM_CONTEXT_GIT_USER: string;
```

기본값 객체(`:123` 부근)에 추가:

```typescript
    CLAUDE_MEM_CONTEXT_GIT_USER: 'all',
```

- [ ] **Step 4: ContextConfig에 필드 추가**

`src/services/context/types.ts:13`의 `ContextConfig`에 `showLastMessage: boolean;` 다음 줄에 추가:

```typescript
  gitUserFilter: string | null;
```

- [ ] **Step 5: 해석 함수와 로더 구현**

`src/services/context/ContextConfigLoader.ts`에 import와 함수를 추가한다:

```typescript
import { getGitUser } from '../../utils/git-user.js';
```

```typescript
/**
 * CLAUDE_MEM_CONTEXT_GIT_USER 설정값을 실제 필터 값으로 해석한다.
 * null은 "필터 없음(전원)"을 뜻한다.
 *
 * `me`인데 현재 git user를 읽을 수 없으면 전원으로 폴백한다. 작성자를 모른다는
 * 이유로 컨텍스트를 통째로 비우는 것은 사용자에게 손해다.
 */
export function resolveGitUserFilter(
  setting: string | undefined,
  readGitUser: () => string | null
): string | null {
  const value = (setting ?? '').trim();
  if (value === '' || value.toLowerCase() === 'all') return null;
  if (value.toLowerCase() === 'me') return readGitUser();
  return value;
}
```

`loadContextConfig()`의 반환 객체에 추가:

```typescript
    gitUserFilter: resolveGitUserFilter(
      settings.CLAUDE_MEM_CONTEXT_GIT_USER,
      () => getGitUser(process.cwd())
    ),
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `bun test tests/context/observation-git-user-filter.test.ts`
Expected: PASS — 5 pass

- [ ] **Step 7: 쿼리에 필터 적용**

`src/services/context/ObservationCompiler.ts`의 `queryObservations`에서 WHERE 절에 조건을 조건부로 덧붙인다. 이 쿼리는 `observations`만 대상으로 하므로 직접 컬럼 비교가 안전하다.

`:46-51`의 WHERE 절 다음에 조건 문자열을 만들어 삽입한다:

```typescript
  const gitUserClause = config.gitUserFilter ? 'AND o.git_user = ?' : '';
```

SQL 템플릿의 `AND EXISTS (...)` 블록 다음 줄에 `${gitUserClause}`를 넣고, 바인딩 파라미터 배열에서 concept 파라미터 다음, `LIMIT` 파라미터 앞에 `config.gitUserFilter`를 조건부로 끼워 넣는다:

```typescript
  const params = [
    project,
    project,
    ...typeArray,
    ...conceptArray,
    ...(config.gitUserFilter ? [config.gitUserFilter] : []),
    config.totalObservationCount,
  ];
```

`queryObservationsMulti`(`:88`)에도 동일하게 적용한다. **바인딩 순서가 SQL의 `?` 순서와 정확히 일치해야 한다** — 어긋나면 조용히 잘못된 결과가 나온다.

- [ ] **Step 8: 헤더에 필터 상태 표시**

필터가 걸린 컨텍스트에서 "기록이 없음"과 "걸러짐"을 구분할 수 있어야 한다. `src/services/context/formatters/HumanFormatter.ts`의 `renderHumanHeader`(`:24`)를 수정한다:

```typescript
export function renderHumanHeader(project: string, gitUserFilter: string | null = null): string[] {
  const filterNote = gitUserFilter ? ` · filtered to ${gitUserFilter}` : '';
  return [
    '',
    `${colors.bright}${colors.cyan}[${project}] recent context, ${formatHeaderDateTime()}${filterNote}${colors.reset}`,
    `${colors.gray}${'─'.repeat(60)}${colors.reset}`,
    ''
  ];
}
```

`renderHumanHeader`를 호출하는 지점(`src/services/context/ContextBuilder.ts`의 `renderHeader`)에서 `config.gitUserFilter`를 넘긴다.

- [ ] **Step 9: 컨텍스트 테스트 회귀 확인**

Run: `bun test tests/context/`
Expected: PASS

- [ ] **Step 10: 기본값이 기존 동작을 유지하는지 수동 확인**

Run: `bun test tests/context-injection.test.ts`
Expected: PASS — 설정을 하지 않은 상태에서 주입 결과가 이전과 같아야 한다

- [ ] **Step 11: 커밋**

```bash
git add src/shared/SettingsDefaultsManager.ts src/services/context/ tests/context/observation-git-user-filter.test.ts
git commit -m "feat: CLAUDE_MEM_CONTEXT_GIT_USER로 컨텍스트 작성자 필터 추가"
```

---

### Task 10: server-beta 전달 및 저장

**Files:**
- Modify: `src/cli/handlers/session-init.ts:71`, `:89`
- Modify: `src/server/generation/processGeneratedResponse.ts:135-150`
- Test: `tests/server/observation-git-user-metadata.test.ts`

**Interfaces:**
- Consumes: `getGitUser` (Task 1)
- Produces: `server_sessions.metadata.gitUser`, `observations.metadata.gitUser`

- [ ] **Step 1: 훅이 서버로 gitUser를 보내도록 수정**

`src/cli/handlers/session-init.ts`에서 Task 3에 추가한 `const gitUser = getGitUser(cwd);`를 그대로 재사용한다. 두 곳의 `metadata`를 수정한다.

client 런타임(`:71`):

```typescript
          metadata: { project, prompt, gitUser },
```

server-beta 런타임(`:89`):

```typescript
          metadata: { project, prompt, gitUser },
```

- [ ] **Step 2: 실패하는 테스트 작성**

`tests/server/observation-git-user-metadata.test.ts`:

```typescript
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
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `bun test tests/server/observation-git-user-metadata.test.ts`
Expected: FAIL — `resolveSessionGitUser is not a function`

- [ ] **Step 4: 헬퍼 구현 및 관측 metadata에 복사**

`src/server/generation/processGeneratedResponse.ts`에 export 함수를 추가한다:

```typescript
/**
 * server_sessions.metadata에서 gitUser를 안전하게 꺼낸다. 이 metadata는 클라이언트
 * 훅이 보낸 값이라 형태를 신뢰할 수 없다.
 */
export function resolveSessionGitUser(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>).gitUser;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}
```

관측 생성 루프(`:135`) **앞에서** 세션을 한 번 조회해 작성자를 구한다. 루프 안에서 조회하면 관측 수만큼 쿼리가 나간다:

```typescript
    const sessionsRepo = new PostgresServerSessionsRepository(this.client);
    const sessionGitUser = fresh.serverSessionId
      ? resolveSessionGitUser(
          (await sessionsRepo.getByIdForScope({
            id: fresh.serverSessionId,
            projectId: fresh.projectId,
            teamId: fresh.teamId,
          }))?.metadata
        )
      : null;
```

`PostgresServerSessionsRepository`는 `src/storage/postgres/server-sessions.ts:45`에 있고 `getByIdForScope`는 `:99`다. 생성자에 넘길 queryable 인스턴스는 같은 함수 안에서 `obsRepo`/`sourcesRepo`를 만들 때 쓰는 것과 동일한 값을 쓴다.

`obsRepo.create`의 `metadata` 객체(`:142-151`)에 필드를 추가한다:

```typescript
        metadata: {
          title: parsedObservation.title,
          subtitle: parsedObservation.subtitle,
          facts: parsedObservation.facts,
          narrative: parsedObservation.narrative,
          concepts: parsedObservation.concepts,
          files_read: parsedObservation.files_read,
          files_modified: parsedObservation.files_modified,
          provider: input.providerLabel,
          model: input.modelId ?? null,
          gitUser: sessionGitUser,
        },
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `bun test tests/server/observation-git-user-metadata.test.ts`
Expected: PASS — 3 pass

- [ ] **Step 6: 서버 테스트 회귀 확인**

Run: `bun test tests/server/`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add src/cli/handlers/session-init.ts src/server/generation/processGeneratedResponse.ts tests/server/observation-git-user-metadata.test.ts
git commit -m "feat: server-beta 관측 metadata에 작성자 기록"
```

---

### Task 11: server-beta 표시와 검색 필터

**Files:**
- Modify: `src/server/runtime/ServerViewerDataRoutes.ts:30-31`, `:74-75`, `:116-117`
- Modify: `src/storage/postgres/observations.ts:170-187`
- Modify: `src/servers/mcp-server.ts:649-662`
- Test: `tests/server/server-viewer-git-user.test.ts`

**Interfaces:**
- Consumes: `observations.metadata.gitUser` (Task 10)
- Produces: 서버 뷰어 API의 `gitUser` 필드, `searchObservations`의 `gitUser` 옵션

- [ ] **Step 1: 뷰어 API가 필드를 내보내도록 수정**

`src/server/runtime/ServerViewerDataRoutes.ts`의 응답 타입(`:30-31`)에 추가:

```typescript
  gitUser: string | null;
```

`:74` 부근과 `:116` 부근 두 곳의 매핑에 추가한다. `:74`는 `asStringOrNull` 헬퍼를 쓰는 형태다:

```typescript
    gitUser: asStringOrNull(meta.gitUser),
```

`:116`은 인라인 타입 검사 형태다:

```typescript
    gitUser: typeof meta.gitUser === 'string' ? meta.gitUser : null,
```

여기서도 title에 합치지 않는다.

- [ ] **Step 2: postgres 검색에 필터 추가**

`src/storage/postgres/observations.ts`의 검색 메서드(`:170-187`)에서 입력 타입에 `gitUser?: string | null`을 추가하고, WHERE 절과 파라미터를 조건부로 구성한다:

```typescript
    const gitUserClause = input.gitUser ? `AND metadata->>'gitUser' = $5` : '';
    const result = await this.client.query<ObservationRow>(
      `
        SELECT * FROM observations
        WHERE project_id = $1
          AND team_id = $2
          AND content_search @@ websearch_to_tsquery('english', $3)
          ${gitUserClause}
        ORDER BY ts_rank(content_search, websearch_to_tsquery('english', $3)) DESC, updated_at DESC
        LIMIT $4
      `,
      input.gitUser
        ? [input.projectId, input.teamId, input.query, input.limit ?? 20, input.gitUser]
        : [input.projectId, input.teamId, input.query, input.limit ?? 20]
    );
```

`$5`가 `LIMIT $4`보다 뒤 번호인 것은 의도적이다 — 파라미터 번호는 배열 인덱스를 따르지 SQL 내 등장 순서를 따르지 않는다.

- [ ] **Step 3: MCP observation_search에 파라미터 노출**

`src/servers/mcp-server.ts:649`의 `observation_search` 도구 스키마에 추가한다. 이 도구는 `additionalProperties: false`이므로 **속성을 선언하지 않으면 인자가 거부된다**:

```typescript
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string', description: 'Search query (required)' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
        gitUser: { type: 'string', description: 'Filter by git author (git config user.name)' },
      },
```

description도 갱신하고, `handleObservationSearch`가 `gitUser`를 클라이언트 호출로 전달하도록 배선한다.

- [ ] **Step 4: 실패하는 테스트 작성 후 통과 확인**

`tests/server/server-viewer-git-user.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';

// ServerViewerDataRoutes의 매핑 함수가 export되어 있지 않다면, 이 테스트는
// metadata -> 응답 매핑 규칙만 검증하는 형태로 둔다.
describe('서버 뷰어 gitUser 매핑', () => {
  it('metadata.gitUser가 문자열이면 그대로, 아니면 null', () => {
    const pick = (meta: Record<string, unknown>) =>
      typeof meta.gitUser === 'string' ? meta.gitUser : null;
    expect(pick({ gitUser: 'bjlee2024' })).toBe('bjlee2024');
    expect(pick({ gitUser: 42 })).toBeNull();
    expect(pick({})).toBeNull();
  });
});
```

Run: `bun test tests/server/`
Expected: PASS

- [ ] **Step 5: 타입 검사**

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add src/server/runtime/ServerViewerDataRoutes.ts src/storage/postgres/observations.ts src/servers/mcp-server.ts tests/server/server-viewer-git-user.test.ts
git commit -m "feat: server-beta 뷰어 노출 및 작성자 검색 필터"
```

---

### Task 12: 통합 검증 및 문서화

**Files:**
- Modify: `docs/public/` 하위 설정 문서 (해당 파일은 `grep -rl "CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS" docs/`로 찾는다)
- Test: 전체 테스트 스위트

**Interfaces:**
- Consumes: Task 1~11 전부
- Produces: 없음

- [ ] **Step 1: 전체 테스트 실행**

Run: `bun test`
Expected: PASS. 실패가 있으면 이 작업으로 생긴 것인지 `git stash`로 확인한 뒤 고친다.

- [ ] **Step 2: 빌드 및 워커 재시작**

Run: `npm run build-and-sync`
Expected: 빌드 성공, 워커 정상 기동

- [ ] **Step 3: 훅 지연 실측**

설계 문서에 "구현 후 실측하여 보고한다"고 적은 항목이다. 세션 시작당 `git config user.name` 호출 비용을 측정한다:

```bash
bun -e 'const {execFileSync}=require("child_process");
const t0=Date.now();
for(let i=0;i<20;i++){try{execFileSync("git",["config","user.name"],{cwd:process.cwd(),encoding:"utf-8",stdio:["ignore","pipe","ignore"]})}catch{}}
console.log("avg ms:", (Date.now()-t0)/20);'
```

측정값을 설계 문서의 "리스크 → 훅 지연" 항목에 실제 수치로 갱신한다.

- [ ] **Step 4: 실제 동작 확인**

새 세션을 시작해 컨텍스트 주입 출력에 `by <user>,`가 붙는지 확인한다. 새로 생성된 관측만 해당하며, 기존 관측은 이름 없이 나오는 것이 정상이다.

- [ ] **Step 5: 설정 문서화**

`CLAUDE_MEM_CONTEXT_GIT_USER` 설정을 기존 컨텍스트 설정들이 문서화된 파일에 추가한다. 한글로 작성한다(프로젝트 규칙). 다음 내용을 포함한다:

- 값: `all`(기본) / `me` / 구체적 이름
- **`git_user`가 `NULL`인 기존 관측은 `me`나 이름 필터에서 전부 제외된다**는 경고
- `me`인데 git user를 읽을 수 없으면 전원으로 폴백한다는 동작

- [ ] **Step 6: 커밋**

```bash
git add docs/
git commit -m "docs: CLAUDE_MEM_CONTEXT_GIT_USER 설정 문서화"
```

---

## 구현자를 위한 주의사항

1. **저장되는 `title`은 절대 바뀌지 않는다.** `formatObservationTitle`은 표시 계층 전용이다. 저장 경로에서 이 함수를 호출하면 검색 인덱스와 임베딩이 오염되고 되돌릴 수 없다.
2. **`buildFilterClause`의 세션 서브쿼리.** Task 8 Step 4에서 `${tableAlias}.git_user = ?`로 쓰고 싶어지겠지만 `session_summaries` 검색이 깨진다. 회귀 테스트가 이를 잡도록 되어 있다.
3. **SQL 바인딩 순서.** Task 9 Step 7에서 조건부 파라미터를 끼워 넣을 때 순서가 어긋나면 에러 없이 잘못된 결과가 나온다.
4. **관측 INSERT 지점이 6곳이다.** Task 4에서 한 곳만 고치면 다른 경로로 저장된 관측은 작성자가 비어 있게 된다.
5. **기본값을 지키자.** `CLAUDE_MEM_CONTEXT_GIT_USER`의 기본값 `all`은 기존 사용자의 동작을 보존하기 위한 것이다.
