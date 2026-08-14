# server-beta 프롬프트 저장·조회 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** server-beta에서 사용자 프롬프트를 전부 저장하고 뷰어의 `/api/prompts`로 조회할 수 있게 하며, `/claude-mem:pause`가 프롬프트 기록도 멈추게 한다.

**Architecture:** `session-init` 훅이 세션 시작 직후 `event_type = 'user_prompt'` 이벤트를 하나 더 보낸다. `generate: false`로 보내 관측 생성 job을 만들지 않는다. postgres 마이그레이션 없이 기존 `agent_events` 테이블과 그 스코프·인덱스·세션 연결을 그대로 쓴다. 뷰어의 `/api/prompts`는 그 테이블을 `event_type` 필터로 조회한다.

**Tech Stack:** TypeScript, PostgreSQL, Express, Bun (`bun test`)

**설계 문서:** `docs/superpowers/specs/2026-08-13-server-beta-prompt-capture-design.md`

## Global Constraints

- 프롬프트 이벤트는 **반드시 `generate: false`** 로 보낸다. 빠지면 프롬프트마다 LLM 생성 job이 돌아 조용히 비용이 늘어난다 — 에러도 안 나고 결과물만 늘어나므로 테스트로 고정한다.
- `event_type`은 정확히 `'user_prompt'`. `/api/prompts` 조회가 이 값에 의존한다.
- **`session-init`의 세션 생성과 컨텍스트 주입은 pause와 무관하게 항상 실행한다.** 프롬프트 이벤트 전송만 조건부다. 세션 행이 없으면 이후 이벤트가 세션에 연결되지 않아 다른 기능이 깨진다.
- 세션 metadata의 기존 `prompt` 필드는 건드리지 않는다. 첫 프롬프트가 세션 제목 역할을 하고 있다.
- postgres 마이그레이션 없음. 새 테이블 없음. 새 인덱스 없음.
- `/api/prompts` 응답은 기존 `/api/observations`와 같은 `{ items, hasMore, offset, limit }` 형태.
- 세션에 연결되지 않은 프롬프트 이벤트도 **반환한다.** 본문은 있으므로 목록에서 빠지는 편이 더 혼란스럽다.
- 소스 주석은 영어, 문서는 한국어. 새 의존성 없음.

## File Structure

**수정**
- `src/cli/handlers/session-init.ts` — 두 런타임 분기(client `:61-79`, server-beta `:81-100`)에서 프롬프트 이벤트 전송, pause 조건 포함
- `src/server/runtime/ServerViewerDataRoutes.ts:146-149` — `/api/prompts` 실제 구현
- `docs/public/configuration.mdx` — pause가 이제 프롬프트도 막는다는 갱신
- `plugin/skills/pause/SKILL.md` — 같은 갱신

**테스트**
- `tests/cli/handlers/session-lifecycle-client.test.ts` — 프롬프트 이벤트 전송과 pause 연동 (이 파일이 이미 client 런타임 mock을 갖추고 있다)

---

### Task 1: 프롬프트 이벤트 전송과 pause 연동

**Files:**
- Modify: `src/cli/handlers/session-init.ts`
- Test: `tests/cli/handlers/session-lifecycle-client.test.ts`

**Interfaces:**
- Consumes: `isSessionPaused(sessionId)` from `src/shared/session-pause.js`; `client.recordEvent({ projectId, contentSessionId, sourceType, eventType, occurredAtEpoch, payload, generate })` from `ServerBetaClient`
- Produces: `agent_events` rows with `event_type = 'user_prompt'` and `payload.prompt`

**설계 판단 하나 — 왜 `ClientWriter`를 쓰지 않는가:**

`ClientWriter.recordEvent`(`src/services/hooks/client-write.ts:27-33`)의 `RecordEventInput`에는 `generate` 필드가 없고, spool 재전송(`spool-flush.ts:17-25`)도 마찬가지다. writer를 쓰면 `generate: false`를 전달할 방법이 없어 오프라인 재전송 시 관측이 생성된다. 두 곳에 `generate` 지원을 추가하는 것은 이 작업의 범위를 넘는다.

대신 `client.recordEvent`를 직접 호출한다. **이는 기존 패턴과 일관된다** — 같은 함수의 `startSession` 호출도 직접 호출이고 실패를 삼킨다(`session-init.ts:76-78`). 오프라인이면 세션 자체가 유실되므로 프롬프트만 spool로 보호해도 연결할 세션이 없다. `session-init` 전체가 best-effort다.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/cli/handlers/session-lifecycle-client.test.ts`에 케이스를 추가한다. **새 파일을 만들지 않는다** — 이 파일은 client 런타임 mock과 `afterAll` 복원을 이미 갖추고 있고, 복제하면 drift가 생기며 복원을 빠뜨리면 무관한 테스트가 대량으로 깨진다(이 저장소에서 62개가 깨진 전례가 있다).

그 파일에는 이미 `let startSessionCalls: Array<unknown> = []`(`:97`)가 있고 client stub의 `startSession`이 거기에 push한다(`:131`), `beforeEach`에서 비운다(`:178`). 같은 방식으로 `recordEventCalls` 배열을 추가하고 stub의 `recordEvent`가 push하게 한다. `clientInput()`의 프롬프트는 `'Hello, do something'`이다(`:223`).

주의: 이 파일에는 `writerRecordEventCalls`(`:346`)라는 **다른** 배열이 이미 있다 — `ClientWriter` 경유 호출을 잡는 것으로, 우리가 추가하는 직접 호출과 다르다. 이름을 겹치지 않게 하고, 기존 배열의 단언을 건드리지 않는다.

```typescript
  it('세션 시작 후 user_prompt 이벤트를 generate:false로 보낸다', async () => {
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    await sessionInitHandler.execute(clientInput());

    const promptEvents = recordEventCalls.filter(c => c.eventType === 'user_prompt');
    expect(promptEvents.length).toBe(1);
    expect(promptEvents[0].payload).toEqual({ prompt: 'Hello, do something' });
    // generate:false is what keeps a prompt from spawning an LLM job. Its
    // absence costs money silently, so pin it.
    expect(promptEvents[0].generate).toBe(false);
  });

  it('일시 중지된 세션에서는 프롬프트 이벤트를 보내지 않는다', async () => {
    const { pauseSession, resumeSession } = await import('../../../src/shared/session-pause.js');
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    pauseSession('session-client-1');
    try {
      await sessionInitHandler.execute(clientInput());

      expect(recordEventCalls.filter(c => c.eventType === 'user_prompt').length).toBe(0);
      // The asymmetry is the feature: the session still gets created, so later
      // events can attach to it, and context injection is untouched.
      expect(startSessionCalls.length).toBe(1);
    } finally {
      resumeSession('session-client-1');
    }
  });
```

`clientInput()`이 반환하는 프롬프트 문자열과 `sessionId`, 그리고 `startSessionCalls`/`recordEventCalls`의 실제 변수명은 그 파일에서 확인해 맞춘다. 두 번째 테스트의 `startSessionCalls` 단언이 대조군이다 — 이것 없이는 핸들러가 통째로 조기 반환해도 첫 단언이 통과한다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `bun test tests/cli/handlers/session-lifecycle-client.test.ts`
Expected: FAIL — 첫 테스트가 `promptEvents.length` 0을 받는다. 프롬프트 이벤트를 아직 안 보내기 때문이다.

이 파일에는 전체 스위트 순서에서만 실패하는 기존 flake가 하나 있다. 단독 실행하면 통과하므로, 단독으로 돌려 위 두 케이스만 판정한다.

- [ ] **Step 3: client 런타임 분기에 전송 추가**

`src/cli/handlers/session-init.ts` 상단 import에 추가한다:

```typescript
import { isSessionPaused } from '../../shared/session-pause.js';
```

client 분기(`:61-79`)의 `startSession` 호출 **뒤**, `forwardLogs` 앞에 추가한다:

```typescript
        // Prompt text is a separate event so every prompt is captured — the
        // session row only holds the first one, because startSession returns
        // early for an existing session. generate:false keeps this from
        // queueing an observation-generation job.
        if (!isSessionPaused(sessionId)) {
          try {
            await client.recordEvent({
              projectId,
              contentSessionId: sessionId,
              sourceType: 'hook',
              eventType: 'user_prompt',
              occurredAtEpoch: Date.now(),
              payload: { prompt },
              generate: false,
            });
          } catch (error) {
            logger.error('HOOK', 'client user_prompt event failed (best-effort)', { error: String(error) });
          }
        }
```

`projectId`는 이미 그 블록에서 계산되어 있다. `ServerBetaRecordEventRequest`(`server-beta-client.ts:85-97`)의 필수 필드는 `projectId`, `sourceType`, `eventType`, `occurredAtEpoch`이고, `contentSessionId`·`payload`·`generate`는 optional이다. 위 코드가 그 형태에 맞다.

- [ ] **Step 4: server-beta 런타임 분기에도 동일 적용**

`:81-100`의 server-beta 분기에서 `startSession` 호출 뒤, `return` 앞에 같은 블록을 추가한다. 이 분기는 `runtime.client`와 `runtime.projectId`를 쓴다:

```typescript
        if (!isSessionPaused(sessionId)) {
          try {
            await runtime.client.recordEvent({
              projectId: runtime.projectId,
              contentSessionId: sessionId,
              sourceType: 'hook',
              eventType: 'user_prompt',
              occurredAtEpoch: Date.now(),
              payload: { prompt },
              generate: false,
            });
          } catch (error) {
            logger.error('HOOK', 'server-beta user_prompt event failed (best-effort)', { error: String(error) });
          }
        }
```

두 분기 모두에 넣지 않으면 한쪽 런타임에서만 프롬프트가 쌓여 데이터가 갈린다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `bun test tests/cli/handlers/session-lifecycle-client.test.ts`
Expected: PASS — 추가한 2개 포함

- [ ] **Step 6: `generate: false`가 실제로 지켜지는지 확인**

`generate: false`를 `true`로 잠시 바꿔 첫 테스트가 실패하는지 확인한 뒤 되돌린다. 실패하지 않으면 그 단언이 아무것도 지키지 못하는 것이므로 테스트를 고친다.

- [ ] **Step 7: 회귀 확인**

Run: `bun test tests/cli/ tests/shared/`
Expected: 기존과 동일

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 8: 커밋**

```bash
git add src/cli/handlers/session-init.ts tests/cli/handlers/session-lifecycle-client.test.ts
git commit -m "feat(server-beta): record every user prompt as a user_prompt event"
```

---

### Task 2: `/api/prompts` 구현

**Files:**
- Modify: `src/server/runtime/ServerViewerDataRoutes.ts:146-149`

**Interfaces:**
- Consumes: `agent_events` rows with `event_type = 'user_prompt'` (Task 1)
- Produces: `GET /api/prompts` returning `{ items, hasMore, offset, limit }` where each item matches the viewer's `UserPrompt` shape

- [ ] **Step 1: 기존 조회 핸들러의 형태 확인**

`handleObservations`(`:224-249`)를 읽는다. 그 함수가 이 파일의 조회 패턴이다:
- `parsePagination(req)` → `{ offset, limit, project }`
- `limit + 1`개를 조회해 `rows.length > limit`으로 `hasMore` 판정
- `rows.slice(0, limit).map(mapXToViewer)`
- try/catch → `logger.error` + 500

새 핸들러도 같은 구조를 따른다.

- [ ] **Step 2: 뷰어가 기대하는 필드 확인**

`src/ui/viewer/types.ts`의 `UserPrompt` 인터페이스:

```typescript
export interface UserPrompt {
  id: number;
  content_session_id: string;
  project: string;
  platform_source: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}
```

`id`는 UUID 문자열로 내보낸다. 이 파일은 이미 observations에서 그렇게 하고 있고(`:24` `id: string`), 런타임에는 문제가 없다.

- [ ] **Step 3: 핸들러 구현**

`:146-149`의 빈 배열 반환을 교체한다:

```typescript
    app.get('/api/prompts', (req, res) => this.handlePrompts(req, res));
```

그리고 `handleObservations` 옆에 메서드를 추가한다:

```typescript
  private async handlePrompts(req: Request, res: Response): Promise<void> {
    try {
      const { offset, limit, project } = parsePagination(req);
      const projectFilter = project ? 'AND p.name = $3' : '';
      const params: unknown[] = project ? [limit + 1, offset, project] : [limit + 1, offset];
      const result = await this.pool.query<ViewerPromptRow>(
        `SELECT e.id,
                s.content_session_id,
                p.name AS project_name,
                s.platform_source,
                e.payload->>'prompt' AS prompt_text,
                e.occurred_at,
                row_number() OVER (
                  PARTITION BY e.server_session_id ORDER BY e.occurred_at ASC
                ) AS prompt_number
           FROM agent_events e
           LEFT JOIN server_sessions s ON e.server_session_id = s.id
           LEFT JOIN projects p ON e.project_id = p.id
          WHERE e.event_type = 'user_prompt' ${projectFilter}
          ORDER BY e.occurred_at DESC
          LIMIT $1 OFFSET $2`,
        params
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(mapPromptToViewer);
      res.json({ items, hasMore, offset, limit });
    } catch (err) {
      logger.error('SYSTEM', 'viewer /api/prompts failed', { error: String(err) });
      res.status(500).json({ error: 'InternalError', message: 'Failed to list prompts' });
    }
  }
```

`LEFT JOIN`이어야 한다. 세션에 연결되지 않은 프롬프트 이벤트도 반환해야 하며, `INNER JOIN`이면 그런 행이 조용히 사라진다.

- [ ] **Step 4: 행 타입과 매핑 함수 추가**

`ViewerObservationRow`가 선언된 곳 옆에 추가한다:

```typescript
interface ViewerPromptRow {
  id: string;
  content_session_id: string | null;
  project_name: string | null;
  platform_source: string | null;
  prompt_text: string | null;
  occurred_at: Date;
  prompt_number: string;
}

function mapPromptToViewer(row: ViewerPromptRow) {
  return {
    id: row.id,
    content_session_id: row.content_session_id ?? '',
    project: row.project_name ?? '',
    platform_source: row.platform_source ?? 'claude',
    prompt_number: Number(row.prompt_number),
    prompt_text: row.prompt_text ?? '',
    created_at_epoch: row.occurred_at.getTime(),
  };
}
```

`row_number()`는 postgres에서 `bigint`로 오고 `pg` 드라이버는 이를 문자열로 넘긴다. `Number()`로 변환하지 않으면 뷰어가 문자열을 받는다.

날짜 처리는 이 파일의 기존 방식과 같다 — `mapObservationToViewer`(`:90`)와 `mapRowToObservation`(`:135`) 모두 `createdAt.getTime()`을 쓴다. `pg`가 `timestamptz`를 `Date` 객체로 주므로 `.getTime()`이 바로 동작한다.

- [ ] **Step 5: 타입 검사**

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 6: 서버 테스트 회귀 확인**

Run: `bun test tests/server/`
Expected: 기존과 동일. 이 디렉터리를 단독 실행하면 공유 postgres 상태로 인한 순서 의존 실패가 여럿 나온다 — 변경 전 baseline과 같은 집합인지 비교한다.

- [ ] **Step 7: 커밋**

```bash
git add src/server/runtime/ServerViewerDataRoutes.ts
git commit -m "feat(viewer): implement /api/prompts for server-beta"
```

---

### Task 3: 문서 갱신과 라이브 검증

**Files:**
- Modify: `docs/public/configuration.mdx` (세션 일시 중지 섹션)
- Modify: `plugin/skills/pause/SKILL.md`

**Interfaces:**
- Consumes: Task 1, Task 2

- [ ] **Step 1: pause 문서의 프롬프트 문구 갱신**

`docs/public/configuration.mdx`의 세션 일시 중지 섹션에 "프롬프트 텍스트는 계속 기록된다"는 항목이 있다. 이제 사실이 아니다. 다음 취지로 바꾼다:

- 일시 중지 중에는 도구 관측, 세션 요약, **그리고 사용자 프롬프트** 모두 기록되지 않는다
- 컨텍스트 주입과 세션 생성은 계속된다
- 이미 기록된 것은 지워지지 않는다

기존 항목을 지우지 말고 내용을 정정한다 — 사용자가 13.10.0 문서를 읽고 알던 제약이 바뀌는 것이므로, 무엇이 바뀌었는지 알 수 있어야 한다.

- [ ] **Step 2: pause 스킬의 같은 문구 갱신**

`plugin/skills/pause/SKILL.md` Step 3의 "The text of your prompts is still recorded — pausing does not stop that." 줄을 프롬프트도 멈춘다는 내용으로 바꾼다. 다섯 항목을 열거하는 구조이므로 개수와 흐름을 유지한다.

- [ ] **Step 3: 빌드와 배포**

```bash
npm run build-and-sync
docker compose -f docker-compose.my.yml build
docker compose -f docker-compose.my.yml up -d
```

Expected: 워커 재시작 확인, 컨테이너 healthy

- [ ] **Step 4: 프롬프트가 실제로 쌓이는지 확인**

배포 후 새 프롬프트가 이벤트로 들어오는지 DB에서 직접 본다. **내용은 출력하지 않고 개수와 길이만** 확인한다.

```bash
docker exec claude-mem-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT count(*) AS prompt_events,
       count(server_session_id) AS linked,
       max(length(payload->>'"'"'prompt'"'"')) AS max_len
FROM agent_events WHERE event_type = '"'"'user_prompt'"'"';"'
```

Expected: 배포 이후 프롬프트 수만큼 행이 생기고, `linked`가 `prompt_events`와 같다(세션 연결이 동작).

- [ ] **Step 5: 관측 생성 job이 늘지 않았는지 확인**

`generate: false`가 실제로 지켜지는지가 여기서 드러난다.

```bash
docker exec claude-mem-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT j.source_type, count(*)
FROM observation_generation_jobs j
JOIN agent_events e ON j.agent_event_id = e.id
WHERE e.event_type = '"'"'user_prompt'"'"' GROUP BY 1;"'
```

Expected: **0행.** 한 행이라도 나오면 `generate: false`가 전달되지 않은 것이므로 Task 1로 돌아간다.

- [ ] **Step 6: `/api/prompts` 실제 응답 확인**

```bash
curl -s "http://127.0.0.1:37700/api/prompts?limit=3" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['items']),'건, hasMore:',d['hasMore']); print([{k:(v[:30] if k=='prompt_text' and isinstance(v,str) else v) for k,v in i.items() if k in ('prompt_number','project','platform_source','prompt_text')} for i in d['items'][:2]])"
```

Expected: 항목이 반환되고, `prompt_number`가 문자열이 아닌 숫자이며, `project`와 `platform_source`가 채워진다.

- [ ] **Step 7: pause가 프롬프트를 막는지 확인**

이 단계는 새 세션이 필요하므로 사용자에게 요청한다. 새 세션에서 `/claude-mem:pause` 실행 → 프롬프트 몇 개 입력 → `/claude-mem:resume` → 위 Step 4 쿼리로 중단 구간의 프롬프트가 없는지 확인.

- [ ] **Step 8: 커밋**

```bash
git add docs/ plugin/ dist/
git commit -m "docs: pause가 프롬프트 기록도 멈춘다는 내용 반영"
```

---

## 구현자를 위한 주의사항

1. **`generate: false`가 이 계획의 핵심 위험이다.** 빠뜨려도 테스트가 없으면 아무 에러 없이 통과하고, LLM 생성 job만 조용히 늘어난다. Task 1 Step 6과 Task 3 Step 5가 그 방어선이다.
2. **두 런타임 분기 모두에 넣는다.** `session-init.ts`에는 client와 server-beta 분기가 따로 있다. 한쪽만 고치면 런타임에 따라 데이터가 갈린다.
3. **`session-init`의 세션 생성과 컨텍스트 주입은 pause와 무관하다.** 프롬프트 이벤트 전송만 조건부다.
4. **`/api/prompts`의 JOIN은 `LEFT`여야 한다.** `INNER`면 세션 미연결 프롬프트가 조용히 사라진다.
5. **`row_number()`는 문자열로 온다.** `Number()` 변환을 빠뜨리면 뷰어가 문자열을 받는다.
