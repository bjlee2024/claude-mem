# 작성자 기준 관측 조회 커맨드 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/claude-mem:filter me|<이름>|off` 슬래시 커맨드로 특정 작성자의 관측만 조회할 수 있게 한다.

**Architecture:** `/v1/search`의 `query`를 optional로 완화해 "검색어 없이 작성자만으로 조회"를 가능하게 하고, 그 위에 얇은 스킬을 얹는다. postgres 쿼리는 검색어 유무에 따라 두 갈래로 완전히 분리한다 — 하나의 템플릿에 조건을 끼워 넣으면 `$n` 파라미터 번호가 어긋나 조용히 틀린 결과를 낸다. 로컬 worker 경로는 이미 검색어 없는 호출을 처리하므로 변경하지 않는다.

**Tech Stack:** TypeScript, PostgreSQL, zod, Express, MCP SDK, Bun (`bun test`)

**설계 문서:** `docs/superpowers/specs/2026-08-11-author-filter-command-design.md`

## Global Constraints

- `query`가 없으면 tsvector 조건을 생략하고 `created_at DESC`로 정렬한다. `ts_rank`는 검색어 없이 의미가 없다.
- 검색어 있음/없음 두 분기는 **SQL 문자열과 파라미터 배열을 각각 따로 구성한다.** 공용 템플릿에 조건부 삽입을 하지 않는다.
- `query`는 optional이 되지만 빈 문자열 `""`은 계속 거부한다(`z.string().min(1).optional()`).
- `gitUser` 필터(`metadata->>'gitUser' = $n`)는 **양쪽 분기 모두**에 적용된다.
- MCP에서 완화하는 대상은 `observation_search`와 `search` 두 도구뿐이다. `observation_context`(`mcp-server.ts:682`)와 `smart_search`(`:788`)의 `required: ['query']`는 **건드리지 않는다.**
- 로컬 worker 경로(`SessionSearch`)는 변경하지 않는다. 이미 `query: string | undefined`를 받는다.
- 새 인덱스를 만들지 않는다. DB 마이그레이션 없음.
- 소스 주석은 영어로 쓴다. 문서는 한국어로 쓴다.
- 새 의존성을 추가하지 않는다.

## File Structure

**신규**
- `plugin/skills/filter/SKILL.md` — 슬래시 커맨드 정의
- `tests/server/search-without-query.test.ts` — 스키마·쿼리 분기 테스트

**수정**
- `src/storage/postgres/observations.ts:169-192` — `search` 메서드 두 갈래 분리
- `src/server/routes/v1/ServerV1PostgresRoutes.ts:953-985` — `/v1/search` 스키마와 audit
- `src/services/hooks/server-beta-client.ts:157-164`, `:392-401` — 요청 타입과 페이로드
- `src/servers/mcp-server.ts:373`, `:540`, `:667` — 필수 검사 3곳

---

### Task 1: postgres 쿼리를 검색어 유무로 분리

**Files:**
- Modify: `src/storage/postgres/observations.ts:169-192`
- Test: `tests/server/search-without-query.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `PostgresObservationRepository.search({ projectId, teamId, query?, limit?, gitUser? })` — `query`가 optional이 된다. 이후 태스크가 이 시그니처에 의존한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/server/search-without-query.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { buildSearchQuery } from '../../src/storage/postgres/observations.js';

describe('buildSearchQuery', () => {
  it('검색어가 있으면 tsvector 조건과 ts_rank 정렬을 쓴다', () => {
    const { sql, params } = buildSearchQuery({
      projectId: 'p1', teamId: 't1', query: 'deployment', limit: 20,
    });
    expect(sql).toContain('websearch_to_tsquery');
    expect(sql).toContain('ts_rank');
    expect(params).toEqual(['p1', 't1', 'deployment', 20]);
  });

  it('검색어가 없으면 tsvector 조건 없이 최신순으로 정렬한다', () => {
    const { sql, params } = buildSearchQuery({
      projectId: 'p1', teamId: 't1', limit: 20,
    });
    expect(sql).not.toContain('websearch_to_tsquery');
    expect(sql).not.toContain('ts_rank');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(params).toEqual(['p1', 't1', 20]);
  });

  it('검색어와 작성자를 함께 주면 둘 다 조건에 들어간다', () => {
    const { sql, params } = buildSearchQuery({
      projectId: 'p1', teamId: 't1', query: 'deployment', limit: 20, gitUser: 'alice',
    });
    expect(sql).toContain('websearch_to_tsquery');
    expect(sql).toContain("metadata->>'gitUser'");
    expect(params).toEqual(['p1', 't1', 'deployment', 20, 'alice']);
  });

  it('검색어 없이 작성자만 주면 작성자 조건만 들어간다', () => {
    const { sql, params } = buildSearchQuery({
      projectId: 'p1', teamId: 't1', limit: 20, gitUser: 'alice',
    });
    expect(sql).not.toContain('websearch_to_tsquery');
    expect(sql).toContain("metadata->>'gitUser'");
    expect(params).toEqual(['p1', 't1', 20, 'alice']);
  });

  it('모든 분기에서 플레이스홀더 개수와 파라미터 개수가 일치한다', () => {
    const cases = [
      { projectId: 'p', teamId: 't', query: 'q', limit: 5 },
      { projectId: 'p', teamId: 't', limit: 5 },
      { projectId: 'p', teamId: 't', query: 'q', limit: 5, gitUser: 'a' },
      { projectId: 'p', teamId: 't', limit: 5, gitUser: 'a' },
    ];
    for (const input of cases) {
      const { sql, params } = buildSearchQuery(input);
      // $1..$n 중 서로 다른 번호의 개수가 파라미터 배열 길이와 같아야 한다.
      const distinct = new Set(sql.match(/\$\d+/g) ?? []);
      expect(distinct.size).toBe(params.length);
      // 번호가 1..n 연속인지도 확인 — 건너뛴 번호가 있으면 postgres가 거부한다.
      const numbers = [...distinct].map(p => Number(p.slice(1))).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: params.length }, (_, i) => i + 1));
    }
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `bun test tests/server/search-without-query.test.ts`
Expected: FAIL — `buildSearchQuery is not a function` (아직 export되지 않음)

- [ ] **Step 3: 쿼리 빌더를 분리해 구현**

`src/storage/postgres/observations.ts`에 export 함수를 추가한다. SQL 조립을 `search`에서 떼어내면 DB 없이 테스트할 수 있다.

```typescript
/**
 * Builds the observation search query. The two branches are kept fully
 * separate on purpose: with no search term there is no tsvector predicate and
 * ts_rank ordering is meaningless, and splicing an optional predicate into one
 * shared template shifts the $n numbering between branches — which postgres
 * accepts silently and answers with the wrong rows.
 */
export function buildSearchQuery(input: {
  projectId: string;
  teamId: string;
  query?: string | null;
  limit?: number;
  gitUser?: string | null;
}): { sql: string; params: unknown[] } {
  const limit = input.limit ?? 20;

  if (input.query) {
    const params: unknown[] = [input.projectId, input.teamId, input.query, limit];
    const gitUserClause = input.gitUser ? `AND metadata->>'gitUser' = $5` : '';
    if (input.gitUser) params.push(input.gitUser);
    return {
      sql: `
        SELECT * FROM observations
        WHERE project_id = $1
          AND team_id = $2
          AND content_search @@ websearch_to_tsquery('english', $3)
          ${gitUserClause}
        ORDER BY ts_rank(content_search, websearch_to_tsquery('english', $3)) DESC, updated_at DESC
        LIMIT $4
      `,
      params,
    };
  }

  const params: unknown[] = [input.projectId, input.teamId, limit];
  const gitUserClause = input.gitUser ? `AND metadata->>'gitUser' = $4` : '';
  if (input.gitUser) params.push(input.gitUser);
  return {
    sql: `
      SELECT * FROM observations
      WHERE project_id = $1
        AND team_id = $2
        ${gitUserClause}
      ORDER BY created_at DESC
      LIMIT $3
    `,
    params,
  };
}
```

- [ ] **Step 4: `search` 메서드가 빌더를 쓰도록 교체**

기존 `search`(`:169`)의 본문을 다음으로 바꾼다. 시그니처의 `query`도 optional이 된다.

```typescript
  async search(input: {
    projectId: string;
    teamId: string;
    query?: string | null;
    limit?: number;
    gitUser?: string | null;
  }): Promise<PostgresObservation[]> {
    const { sql, params } = buildSearchQuery(input);
    const result = await this.client.query<ObservationRow>(sql, params);
    return result.rows.map(mapObservationRow);
  }
```

기존 메서드가 결과를 어떻게 매핑했는지 확인하고(`result.rows.map(mapObservationRow)`) 그 형태를 그대로 유지한다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `bun test tests/server/search-without-query.test.ts`
Expected: PASS — 5 pass

- [ ] **Step 6: 타입 검사와 회귀 확인**

Run: `npx tsc --noEmit`
Expected: 오류 없음

Run: `bun test tests/server/`
Expected: 기존과 동일. 참고로 `tests/server/`를 단독 실행하면 공유 postgres 상태 때문에 순서 의존 실패가 여러 건 나온다 — 변경 전 `git stash`로 baseline을 재보고 같은 집합인지 비교한다.

- [ ] **Step 7: 커밋**

```bash
git add src/storage/postgres/observations.ts tests/server/search-without-query.test.ts
git commit -m "feat(server-beta): allow observation search without a query term"
```

---

### Task 2: `/v1/search`가 query 없는 요청을 받도록

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts:953-985`
- Test: `tests/server/search-without-query.test.ts` (Task 1에서 만든 파일에 추가)

**Interfaces:**
- Consumes: `PostgresObservationRepository.search({ projectId, teamId, query?, limit?, gitUser? })` (Task 1)
- Produces: `POST /v1/search`가 `query` 없이 `{ projectId, gitUser? }` 만으로 200을 반환한다.

- [ ] **Step 1: 스키마를 export 가능한 모듈 상수로 추출**

현재 스키마는 `app.post('/v1/search', …)` 호출 안에 인라인으로 선언되어 있어 테스트에서 참조할 수 없다. **테스트 파일에 스키마를 복제해 검증하면 실제 라우트가 아니라 복제본을 검증하게 되므로 아무것도 보장하지 못한다.** 파일 상단(다른 모듈 상수들이 선언된 위치)으로 옮기고 export한다.

**이 단계에서는 동작을 바꾸지 않는다.** `query`는 아직 필수인 채로 옮기기만 한다 — 그래야 다음 단계의 테스트가 실제로 실패하면서 자신이 실제 라우트를 붙잡고 있음을 증명한다.

`src/server/routes/v1/ServerV1PostgresRoutes.ts`:

```typescript
// Exported so tests can assert the contract directly instead of duplicating it.
export const SearchObservationsSchema = z.object({
  projectId: z.string().min(1),
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  // Optional author filter — see PostgresObservationRepository#search.
  gitUser: z.string().min(1).optional(),
});
```

그리고 `app.post('/v1/search', readAuth, this.handleCreate(` 뒤의 인라인 zod 객체를 `SearchObservationsSchema`로 교체한다. 이 시점에서 `bun test tests/server/` 를 돌려 기존 동작이 유지되는지 확인한다.

- [ ] **Step 2: 실패하는 스키마 테스트 추가**

`tests/server/search-without-query.test.ts` 하단에 추가한다. **라우트가 실제로 쓰는 스키마를 import한다.**

```typescript
import { SearchObservationsSchema } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';

describe('/v1/search 요청 스키마', () => {
  it('query 없이 gitUser만 있어도 통과한다', () => {
    expect(SearchObservationsSchema.safeParse({ projectId: 'p1', gitUser: 'alice' }).success).toBe(true);
  });

  it('query가 아예 없어도 통과한다', () => {
    expect(SearchObservationsSchema.safeParse({ projectId: 'p1' }).success).toBe(true);
  });

  it('빈 문자열 query는 여전히 거부한다', () => {
    expect(SearchObservationsSchema.safeParse({ projectId: 'p1', query: '' }).success).toBe(false);
  });

  it('projectId는 여전히 필수다', () => {
    expect(SearchObservationsSchema.safeParse({ gitUser: 'alice' }).success).toBe(false);
  });
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `bun test tests/server/search-without-query.test.ts`
Expected: FAIL — `query 없이…` 두 케이스가 실패한다. 아직 라우트가 `query`를 필수로 두고 있기 때문이다. 이것이 이 테스트가 실제 코드를 붙잡고 있다는 증거다.

- [ ] **Step 4: 스키마의 `query`를 optional로 바꾼다**

Step 1에서 추출한 `SearchObservationsSchema`의 `query` 한 줄만 고친다. 이것이 테스트를 통과시키는 최소 변경이다.

```typescript
  // Optional: with no query the search returns the most recent observations
  // instead of full-text matches. Empty string stays invalid so a caller
  // cannot accidentally send one.
  query: z.string().min(1).optional(),
```

핸들러의 `repo.search` 호출에서 `query: body.query`는 그대로 둔다 — 이제 `string | undefined`이고 Task 1의 시그니처가 이를 받는다.

- [ ] **Step 5: audit 로그가 값 없는 query를 견디도록**

audit 로그는 `query: body.query`를 기록하는데 값이 없을 수 있다. 다음처럼 바꾼다:

```typescript
          await this.auditRead(req, 'observation.read', null, body.projectId, {
            mode: body.query ? 'search' : 'recent',
            query: body.query ?? null,
            limit: body.limit ?? 20,
            resultCount: results.length,
            observationIds: results.map(o => o.id),
          });
```

`mode`를 갈라두면 감사 로그만 보고도 전문 검색과 최신순 조회를 구분할 수 있다.

- [ ] **Step 6: 테스트 통과 확인**

Run: `bun test tests/server/search-without-query.test.ts`
Expected: PASS — 9 pass (Task 1의 5건 + 이번 4건)

- [ ] **Step 7: 타입 검사**

Run: `npx tsc --noEmit`
Expected: 오류 없음. 오류가 나면 `query`가 required로 선언된 타입이 남아 있다는 뜻이므로 Task 3의 클라이언트 타입을 먼저 확인한다.

- [ ] **Step 8: 커밋**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/search-without-query.test.ts
git commit -m "feat(server-beta): accept /v1/search requests without a query"
```

---

### Task 3: 클라이언트 타입과 MCP 도구의 필수 검사 완화

**Files:**
- Modify: `src/services/hooks/server-beta-client.ts:157-164`, `:392-401`
- Modify: `src/servers/mcp-server.ts:373`, `:540`, `:667`

**Interfaces:**
- Consumes: `POST /v1/search`가 query 없는 요청을 받는다 (Task 2)
- Produces: MCP `search`와 `observation_search`를 `gitUser`만으로 호출할 수 있다. 스킬(Task 4)이 이에 의존한다.

- [ ] **Step 1: 클라이언트 요청 타입 완화**

`src/services/hooks/server-beta-client.ts:157`:

```typescript
export interface ServerBetaSearchObservationsRequest {
  projectId: string;
  // Optional: omitting it returns the most recent observations instead of
  // full-text matches. Mirrors the /v1/search schema.
  query?: string;
  limit?: number;
  // Optional author filter — restricts results to observations captured
  // under this git config user.name (Task 10/11).
  gitUser?: string;
}
```

- [ ] **Step 2: 페이로드 빌더가 query를 조건부로 넣도록**

`:392`의 `buildSearchPayload`를 바꾼다. 지금은 `query`를 무조건 넣어서 `undefined`가 들어가고, 그러면 JSON 직렬화에서 키가 사라지긴 하지만 타입이 거짓말을 하게 된다.

```typescript
  buildSearchPayload(
    input: { projectId: string; query?: string; limit?: number; gitUser?: string },
  ): Record<string, unknown> {
    return {
      projectId: input.projectId,
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.gitUser !== undefined ? { gitUser: input.gitUser } : {}),
    };
  }
```

- [ ] **Step 3: `observation_search` 도구 스키마에서 required 제거**

`src/servers/mcp-server.ts:655-670`. `required: ['query']` 줄을 지우고 description을 갱신한다.

```typescript
    description: 'Full-text search across generated observations using server-beta\'s GIN tsvector index (Phase 1). Calls /v1/search. Server-beta runtime only. Params: query (optional — omit to get the most recent observations), projectId (optional), limit (default 20, max 100), gitUser (optional, filter by git author).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string', minLength: 1, description: 'Search query (optional; omit for most-recent ordering)' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
        gitUser: { type: 'string', minLength: 1, description: 'Filter by git author (git config user.name)' },
      },
      additionalProperties: false,
    },
```

`minLength: 1`을 `query`에 붙여 빈 문자열이 도구 경계에서 걸리도록 한다.

- [ ] **Step 4: `handleObservationSearch`의 런타임 검사 제거**

`mcp-server.ts:372-374`의 다음 세 줄을 삭제한다:

```typescript
    if (typeof args?.query !== 'string' || args.query.trim().length === 0) {
      throw new Error('observation_search: "query" is required');
    }
```

그 아래 `request` 조립도 `query`를 조건부로 바꾼다:

```typescript
    const request: ServerBetaSearchObservationsRequest = {
      projectId,
      ...(typeof args.query === 'string' && args.query.trim().length > 0 ? { query: args.query } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.gitUser !== undefined ? { gitUser: args.gitUser } : {}),
    };
```

- [ ] **Step 5: `search` 도구 server-beta 분기의 검사 제거**

`mcp-server.ts:539-541`의 다음 세 줄을 삭제한다:

```typescript
          if (typeof args?.query !== 'string' || args.query.trim().length === 0) {
            throw new Error('search: "query" is required');
          }
```

그 아래 `searchObservations` 호출도 `query`를 조건부로 바꾼다:

```typescript
          const response = await ctx.client.searchObservations({
            projectId,
            ...(typeof args.query === 'string' && args.query.trim().length > 0 ? { query: args.query } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(args.gitUser !== undefined ? { gitUser: args.gitUser } : {}),
          });
```

- [ ] **Step 6: 건드리지 않은 것 확인**

Run: `grep -n "required: \['query'\]" src/servers/mcp-server.ts`
Expected: 두 줄이 남아야 한다 — `observation_context`와 `smart_search`. 세 줄 다 사라졌다면 잘못 지운 것이므로 되돌린다.

- [ ] **Step 7: 타입 검사와 회귀 확인**

Run: `npx tsc --noEmit`
Expected: 오류 없음

Run: `bun test`
Expected: 기존과 동일 (`tests/cli/handlers/session-lifecycle-client.test.ts` 1건은 이 작업 이전부터 있던 순서 의존 flake)

- [ ] **Step 8: 커밋**

```bash
git add src/services/hooks/server-beta-client.ts src/servers/mcp-server.ts
git commit -m "feat(mcp): allow author-only observation search without a query"
```

---

### Task 4: `/claude-mem:filter` 스킬

**Files:**
- Create: `plugin/skills/filter/SKILL.md`

**Interfaces:**
- Consumes: MCP `search` 도구가 `gitUser`만으로 호출 가능 (Task 3)
- Produces: 없음 (최종 사용자 인터페이스)

- [ ] **Step 1: 기존 스킬의 형식 확인**

Run: `head -20 plugin/skills/mem-search/SKILL.md`
Expected: `---` frontmatter에 `name`과 `description`이 있는 형태. 새 스킬도 같은 형식을 따른다.

- [ ] **Step 2: 스킬 파일 작성**

`plugin/skills/filter/SKILL.md`:

```markdown
---
name: filter
description: Show observations from one git author only. Use when the user asks to see their own past work, or one teammate's work, on the current project — "what did I do here", "show alice's work", "filter by author".
---

# Author Filter

Show observations from a single git author on the current project.

## Usage

- `/claude-mem:filter me` — observations you recorded
- `/claude-mem:filter alice` — observations `alice` recorded
- `/claude-mem:filter off` — most recent observations, no author filter
- `/claude-mem:filter` — same as `me`

## How to run it

**Step 1 — resolve the author.**

For `me` (or no argument), get the current git user:

```bash
git config user.name
```

If that prints nothing or fails, tell the user you could not read their git
author and show unfiltered results instead. Do not return an empty screen.

For a literal name, use it as given. For `off`, skip the filter entirely.

**Step 2 — query.**

Call the `search` tool with no query term, so results come back newest-first:

- with an author: `search({ gitUser: "<resolved name>", limit: 20 })`
- for `off`: `search({ limit: 20 })`

Do not pass a `query`. Passing one turns this into a full-text search and
changes the ordering.

**Step 3 — present the results.**

List them the way `mem-search` does. Titles already carry `by <user>,` so the
author is visible without extra formatting.

## When results are empty

Observations recorded before author capture shipped have no author, so they are
excluded by any author filter. This is expected — say so rather than implying
the history is gone:

> `<name>` 작성자로 기록된 관측이 없습니다. 작성자 기록은 최근에 추가된
> 기능이라 그 이전 관측에는 작성자 정보가 없습니다.

Offer `/claude-mem:filter off` as the way to see everything.

## Notes

- This command only reads. It does not change any setting, and it does not
  affect what gets injected at the start of the next session.
- On the client/server-beta runtime this needs a server built after the
  author-filter change; older servers reject a search with no query term
  with a 400.
```

- [ ] **Step 3: 플러그인 빌드에 포함되는지 확인**

Run: `npm run build && ls ~/.claude/plugins/marketplaces/bjlee2024/plugin/skills/filter/`
Expected: `SKILL.md`가 동기화된 마켓플레이스에 나타난다. 나타나지 않으면 `scripts/sync-marketplace.cjs`가 `plugin/skills`를 어떻게 복사하는지 확인한다.

- [ ] **Step 4: 커밋**

```bash
git add plugin/skills/filter/SKILL.md plugin/
git commit -m "feat(skill): add /claude-mem:filter for author-scoped observation lookup"
```

---

### Task 5: 배포와 라이브 검증

**Files:**
- 없음 (검증 전용)

**Interfaces:**
- Consumes: Task 1~4 전부

- [ ] **Step 1: 전체 검증**

Run: `npm run typecheck`
Expected: root와 viewer 양쪽 통과

Run: `bun test`
Expected: 기존 대비 실패 증가 없음

- [ ] **Step 2: 빌드와 서버 재배포**

```bash
npm run build-and-sync
docker compose -f docker-compose.my.yml build
docker compose -f docker-compose.my.yml up -d
```

Expected: 워커 재시작 확인, 컨테이너 healthy

- [ ] **Step 3: 라이브 API 검증**

서버가 실제로 query 없는 요청을 받는지 확인한다. 자격증명은 설정 파일에서 읽고 **값을 출력하지 않는다.**

```bash
KEY=$(python3 -c "import json;print(json.load(open('$HOME/.claude-mem/settings.json'))['CLAUDE_MEM_SERVER_BETA_API_KEY'])")
PID=$(docker exec claude-mem-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "SELECT project_id FROM observations WHERE metadata->>'"'"'gitUser'"'"' IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1;"' | tr -d '[:space:]')

# query 없이 작성자만
curl -s -X POST http://127.0.0.1:37700/v1/search -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID\",\"gitUser\":\"bjlee2024\",\"limit\":3}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d['observations']),'건')"

# 존재하지 않는 작성자 → 0건이어야 한다
curl -s -X POST http://127.0.0.1:37700/v1/search -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID\",\"gitUser\":\"nobody-xyz\",\"limit\":3}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d['observations']),'건')"

# 빈 문자열 query → 400이어야 한다
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:37700/v1/search \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PID\",\"query\":\"\"}"
```

Expected: 1건 이상 / 0건 / 400

- [ ] **Step 4: 반환된 행의 작성자를 직접 확인**

개수만으로는 필터가 실제로 걸렸는지 알 수 없다. 작성자 값을 확인한다.

```bash
curl -s -X POST http://127.0.0.1:37700/v1/search -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID\",\"gitUser\":\"bjlee2024\",\"limit\":5}" \
  | python3 -c "import sys,json;print({o['metadata'].get('gitUser') for o in json.load(sys.stdin)['observations']})"
```

Expected: `{'bjlee2024'}` — 다른 값이 섞여 있으면 필터가 적용되지 않은 것이다.

- [ ] **Step 5: 커밋**

```bash
git add plugin/ dist/
git commit -m "chore: rebuild artifacts for author filter command"
```

- [ ] **Step 6: 사용자에게 커맨드 확인 요청**

새 세션에서 `/claude-mem:filter me`를 실행해 결과를 확인해 달라고 요청한다. 슬래시 커맨드는 Claude Code가 플러그인 스킬을 로드해야 나타나므로, 플러그인 동기화 후 세션을 새로 열어야 한다.
