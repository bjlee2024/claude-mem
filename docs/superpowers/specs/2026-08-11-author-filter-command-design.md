# 작성자 기준 관측 조회 슬래시 커맨드

작성일: 2026-08-11
상태: 설계 승인됨

## 목표

Claude 세션 안에서 슬래시 커맨드 하나로 특정 작성자의 관측만 조회한다.

```
/claude-mem:filter me       → 내가 기록한 관측만
/claude-mem:filter alice    → alice가 기록한 관측만
/claude-mem:filter off      → 작성자 구분 없이 최근 관측
```

13.8.0이 Observation에 git 작성자를 기록하기 시작했고, `search` 도구에 `gitUser`
파라미터도 붙였다. 하지만 그 파라미터를 쓰려면 검색어가 반드시 있어야 해서 "내가 최근에 뭘
했더라"를 물어볼 수단이 없다. 이 설계는 그 간극을 메운다.

## 조사로 확인된 사실

라이브 server-beta 인스턴스(`127.0.0.1:37700`)에 직접 요청해 확인했다.

1. `/v1/search`의 `query`는 **필수**다(`z.string().min(1)`). 빈 문자열을 보내면 400이다
   (`ServerV1PostgresRoutes.ts:953-960`).
2. `/v1/context`는 빈 query를 허용한다(200). 즉 "빈 query 조회"와 "작성자 필터"가 서로 다른
   엔드포인트에 하나씩 있고, 둘을 겸비한 경로가 없다.
3. `/v1/search`의 `gitUser` 필터는 실제로 동작한다. 같은 프로젝트·같은 검색어로
   `gitUser=bjlee2024` → 2건, `gitUser=nobody` → 0건, 필터 없음 → 5건.
4. 로컬 worker 경로의 `SessionSearch.searchObservations(query: string | undefined, …)`는
   **이미 검색어 없는 호출을 받는다**. 지금은 server-beta 쪽만 막혀 있다.
5. 작성자가 기록된 관측은 전체 55,012건 중 158건뿐이다(이 기능 이후 생성분).
6. MCP 쪽 `required: ['query']`는 세 곳에 있는데 각각 다른 도구다 —
   `observation_search`(`mcp-server.ts:667`), `observation_context`(`:682`),
   `smart_search`(`:788`).

## 결정 사항

| 항목 | 결정 |
| --- | --- |
| 커맨드 동작 | 조회 전용. 설정을 바꾸거나 다음 세션 주입에 영향을 주지 않는다 |
| 인자 | `me` / 작성자 이름 / `off` |
| 조회 경로 | `/v1/search`의 `query`를 optional로 완화해 재사용 |
| `me` 해석 | 스킬이 `git config user.name`을 실행해 얻는다 |

### `/v1/search` 완화를 택한 이유

검토한 대안은 셋이었다.

- **`/v1/context`에 `gitUser` 추가**: 빈 query를 이미 허용하므로 당장은 편하다. 그러나 이
  엔드포인트는 "세션 시작 시 주입용"이라는 다른 목적을 가지며, 조회 용도로 겸용하면 주입
  로직이 바뀔 때 함께 흔들린다. 탈락.
- **커맨드가 검색어를 함께 받기**: 서버를 건드리지 않지만 "내가 최근에 뭘 했지"를 물을 수
  없다. 요구사항 자체를 만족하지 못한다. 탈락.
- **`/v1/search`의 `query`를 optional로 (채택)**: 변경이 가장 작고, `search`의 의미에
  부합하며, 작성자 필터 외의 용도("이 프로젝트 최근 관측 N개")로도 재사용된다. 무엇보다 이미
  검색어 없는 호출을 받는 worker 경로와 **동작이 일치하게 된다** — 현재의 불일치가 오히려
  결함에 가깝다.

## 서버 변경

### 스키마

`ServerV1PostgresRoutes.ts`의 `/v1/search` 스키마에서 `query`를 optional로 바꾼다.

```
query: z.string().min(1).optional()
```

`gitUser`는 이미 optional이다. `projectId`는 그대로 필수다.

### 쿼리 분기

`PostgresObservationRepository.search`(`src/storage/postgres/observations.ts:169`)를 두 갈래로
나눈다.

- **검색어 있음** — 현재 동작 유지. `content_search @@ websearch_to_tsquery(...)` 조건과
  `ts_rank(...) DESC, updated_at DESC` 정렬.
- **검색어 없음** — tsvector 조건을 생략하고 `created_at DESC`로 정렬. `ts_rank`는 검색어
  없이 의미가 없으므로 정렬 기준도 함께 갈라진다.

**두 분기의 SQL 문자열과 파라미터 배열을 각각 따로 구성한다.** 하나의 템플릿에 조건을 끼워
넣으면 `$n` 번호가 분기마다 달라져 어긋나기 쉽다. 현재 코드도 `gitUser`가 `$5`인데 `LIMIT`이
`$4`라 이미 헷갈리는 자리다. 어긋나면 예외 없이 조용히 잘못된 행을 반환한다.

`gitUser` 필터(`metadata->>'gitUser' = $n`)는 양쪽 분기 모두에 조건부로 적용된다.

## MCP 도구 변경

세 곳만 손댄다.

| 위치 | 내용 |
| --- | --- |
| `mcp-server.ts:667` | `observation_search`의 `required: ['query']` 제거 |
| `mcp-server.ts:373` | `handleObservationSearch`의 `"query" is required` 런타임 검사 제거 |
| `mcp-server.ts:540` | `search` 도구 server-beta 분기의 같은 검사 제거 |

**건드리지 않는 것**: `observation_context`(`:682`)와 `smart_search`(`:788`)의
`required: ['query']`. 전자는 컨텍스트 주입용이라 검색어가 의미를 갖고, 후자는 코드 구조
검색이라 이 작업과 무관하다.

로컬 worker 경로는 변경이 없다. 이미 검색어 없는 호출을 처리한다.

## 스킬

`plugin/skills/filter/SKILL.md`를 새로 만든다. 호출 형태는 `/claude-mem:filter <인자>`로,
기존 `claude-mem:mem-search`와 같은 규칙이다.

동작:

| 입력 | 처리 |
| --- | --- |
| `me` | `git config user.name` 실행 → 그 값으로 `search(gitUser: …)` 호출 |
| `<이름>` | 그 이름으로 `search(gitUser: …)` 호출 |
| `off` | `gitUser` 없이 `search` 호출 |
| 인자 없음 | `me`와 동일하게 처리 |

`me`인데 `git config user.name`을 읽을 수 없으면, 그 사실을 사용자에게 말하고 `off`처럼 전체를
보여준다. 빈 화면을 돌려주는 것보다 낫다.

출력은 기존 `mem-search` 스킬의 결과 표기를 따른다. 제목에 이미 `by <user>,`가 붙으므로
작성자는 자연히 드러난다.

**결과가 비었을 때는 이유를 함께 알린다.** 이 기능 이전에 기록된 관측에는 작성자가 없어
`me`나 이름 필터에서 전부 제외된다. 현재 이 서버 기준 55,012건 중 158건만 작성자를 가진다.
따라서 당분간 결과가 매우 적게 나오는 것이 정상이며, 사용자가 이를 고장으로 오해하지 않도록
빈 결과에 그 설명을 덧붙인다.

## 테스트

- **postgres 쿼리 분기**: 검색어 있음/없음 × `gitUser` 있음/없음 네 조합. 특히 **검색어 없이
  `gitUser`만** 준 경우 해당 작성자의 행만, 최신순으로 오는지. 파라미터 정렬이 어긋나면
  예외 없이 틀린 결과가 나오므로 반환된 행의 작성자를 직접 단언한다.
- **스키마**: `query` 없는 요청이 200, 빈 문자열 `""`은 여전히 400(`.min(1)` 유지).
- **MCP 도구**: `query` 없이 `gitUser`만으로 호출이 통과하는지. `observation_context`와
  `smart_search`는 여전히 `query`를 요구하는지 — 회귀 방지.

postgres 쿼리 자체의 실행 검증은 라이브 DB가 필요하므로 `scripts/e2e-server-beta-docker.sh`
영역이다. 배포 후 실제 인스턴스에 요청해 확인한다.

## 리스크

- **파라미터 번호 어긋남**: 위에서 강조한 대로 조용히 틀린 결과를 낸다. 분기별로 배열을 따로
  만들고 테스트가 반환 행을 단언하는 것으로 막는다.
- **검색어 없는 조회의 비용**: tsvector 인덱스를 타지 않고 `created_at DESC` 정렬이 된다.
  `project_id` 스코프 안에서의 정렬이라 실용적인 규모지만, 프로젝트가 매우 커지면
  `(project_id, created_at DESC)` 인덱스를 검토한다. 이번 범위에는 넣지 않는다.
- **서버 재배포 필요**: 이 변경은 서버 측이다. 클라이언트는 갱신하지 않아도 되지만 서버를
  재빌드하기 전에는 커맨드가 400을 받는다.

## 범위 밖

- 설정을 바꿔 다음 세션의 컨텍스트 주입을 필터링하는 것. 이번 커맨드는 조회 전용이다.
- `/v1/context`의 변경.
- 뷰어 UI의 작성자 필터.
- 작성자가 없는 과거 관측의 백필. 원 작성자를 알 방법이 없다.
