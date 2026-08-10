# Observation 작성자(git user) 기록 및 표시

작성일: 2026-08-10
상태: 설계 승인됨

## 목표

Observation을 생성할 때 해당 작업을 수행한 git 사용자를 함께 기록하고, Observation 제목이
표시되는 모든 지점에 `by <user>` 형태로 작성자를 노출한다.

목표 표시 형태:

```
General
  #49  9:51 AM  🔵  by bjlee2024, NPM Registry Latest Version (~69t)
../../home/bj/Work/servers/claude-mem
  #48  9:52 AM  🟣  by medit-minheecho, Version Bump Implemented (~86t)
  #47  9:53 AM  🟣  by superman, NPM Version Upgrade to 13.5.0 (~77t)
```

한 프로젝트의 Observation 목록에 여러 작성자가 섞여 나타나는 것이 이 기능의 핵심 가치이며,
이는 팀이 하나의 프로젝트를 공유하는 server-beta 시나리오에서 발생한다.

## 조사로 확인된 사실

설계의 근거가 되는 사실들. 모두 코드 확인 또는 실행으로 검증했다.

1. `git config user.name`은 repo-local 설정이 없으면 global 값으로 폴백한다. **git repo가
   아닌 디렉터리에서도 global 값이 반환된다** (`/tmp`에서 실행 시 `bjlee2024` 반환).
2. 로컬 sqlite `observations` 테이블은 `title`을 실제 컬럼으로 가진다. `metadata TEXT` 컬럼도
   이미 존재하지만(#2116) 거의 사용되지 않는다.
3. **server-beta postgres `observations` 테이블에는 `title` 컬럼이 없다.** title/subtitle을
   포함한 모든 구조화 필드가 `metadata` JSONB 안에 저장된다
   (`src/server/generation/processGeneratedResponse.ts:143`,
   `src/server/runtime/ServerViewerDataRoutes.ts:74`).
4. 세션 시작 훅은 이미 server-beta로 `metadata: { project, prompt }`를 전송한다
   (`src/cli/handlers/session-init.ts:71`, `:89`).
5. 로컬 worker 경로는 `/api/sessions/init`로 `{ contentSessionId, project, prompt,
   platformSource }`를 전송하며, zod 스키마가 `.passthrough()`로 열려 있다
   (`src/services/worker/http/routes/SessionRoutes.ts:179-185`).
6. 관측 저장 시점에 `ResponseProcessor`는 `session` 객체를 들고 있으며 여기서 `session.project`
   등을 읽어 쓴다 (`src/services/worker/agents/ResponseProcessor.ts:154`, `:304`).
7. 서버 측 관측 생성은 generation job(`fresh`)을 통해 이루어지며 `fresh.serverSessionId`로
   세션을 참조할 수 있다 (`processGeneratedResponse.ts:138`).
8. 기존 컬럼 추가 마이그레이션 패턴이 존재한다 — `PRAGMA table_info` 확인 후
   `ALTER TABLE ADD COLUMN` (`src/services/sqlite/migrations/runner.ts:779-790`의 `agent_type`).

## 결정 사항

| 항목 | 결정 |
| --- | --- |
| 저장할 값 | `git config user.name` |
| 저장 위치 | Observation 전용 필드 (제목 문자열에 삽입하지 않음) |
| 표시 범위 | 제목이 표시되는 모든 지점 |
| 적용 런타임 | 로컬 worker(sqlite) + server-beta(postgres) 양쪽 |
| 캡처 시점 | 세션 시작 시 1회 캡처 후 Observation에 복사 |

### 캡처 시점을 세션 단위로 정한 이유

검토한 대안은 세 가지였다.

- **관측 저장 시점에 직접 조회**: server-beta에서는 성립하지 않는다. 서버에는 repo도 cwd도
  없다. 두 런타임의 동작이 갈라지므로 탈락.
- **모든 훅 이벤트에 실어 보내기**: 세션 도중 git 설정 변경도 반영되지만, 훅마다 git 프로세스를
  spawn한다. 훅은 사용자 입력 경로에 있어 비용이 직접 체감된다.
- **세션 시작 시 1회 캡처 (채택)**: 두 런타임이 동일한 모델을 사용하고, 이미 존재하는 세션
  metadata 전달 통로를 재사용하며, git 호출 비용이 세션당 1회로 고정된다.

트레이드오프: 세션 진행 중 `git config user.name`을 변경해도 해당 세션에는 반영되지 않는다.
실무상 무시할 수 있는 제약으로 판단한다.

## 데이터 모델

### 로컬 (sqlite)

title이 실제 컬럼이므로 대칭적으로 전용 컬럼을 추가한다.

- `sdk_sessions.git_user TEXT`
- `observations.git_user TEXT`
- `CREATE INDEX IF NOT EXISTS idx_observations_git_user ON observations(git_user)`

마이그레이션은 `runner.ts`의 `agent_type` 추가 패턴을 그대로 따른다. 컬럼 존재 여부를
`PRAGMA table_info`로 확인한 뒤 추가하므로 재실행이 멱등하다.

### 서버 (postgres)

title/subtitle이 이미 `metadata` JSONB에 있으므로 같은 계층에 넣는다. **스키마 변경 없음.**

- `server_sessions.metadata.gitUser`
- `observations.metadata.gitUser`

## 캡처: `src/utils/git-user.ts` (신규)

```
getGitUser(cwd: string | null | undefined): string | null
```

- `git config user.name`을 `execFileSync`로 실행한다. `src/utils/project-name.ts`의
  `findGitRepoRoot`와 동일한 패턴을 쓴다 — `stdio: ['ignore', 'pipe', 'ignore']`로 stderr를
  버리고, 실패는 예외를 삼켜 `null`을 반환한다.
- 반환값 정규화: `trim()`, 개행/탭을 공백으로 치환, 64자로 절단.
- 미설정, git 미설치, 존재하지 않는 cwd, 빈 문자열은 모두 `null`.
- 프로세스 내 `cwd → 결과` 메모 캐시를 둔다.

git repo가 아닌 디렉터리에서 global `user.name`이 반환되는 동작은 그대로 허용한다. 비-git
프로젝트에서도 작업한 사람은 동일하기 때문이다.

## 전달

### 로컬 worker

1. `session-init` 훅이 `getGitUser(cwd)`를 1회 호출한다.
2. `/api/sessions/init` body에 `gitUser`를 추가한다.
3. `sessionInitByClaudeIdSchema`에 `gitUser: z.string().optional()`을 추가한다.
4. `SessionRoutes`가 `sdk_sessions.git_user`에 저장한다.
5. 관측 저장 시 `ResponseProcessor`가 `session` 객체에서 읽어 `observations.git_user`로 복사한다.
   `session.project`를 넘기는 자리와 동일한 위치에 추가한다.

### server-beta

1. 같은 훅 호출 결과를 `startSession`의 `metadata`에 추가한다:
   `metadata: { project, prompt, gitUser }`. 이 경로는 `session-init.ts:71`(client 런타임)과
   `:89`(server-beta 런타임) 두 곳이다.
2. `processGeneratedResponse`가 `fresh.serverSessionId`로 세션을 조회해
   `metadata.gitUser`를 읽는다 (세션 조회 1회 추가).
3. 읽은 값을 관측 생성 시 `metadata.gitUser`로 복사한다.

## 표시

공통 헬퍼를 하나 두고 모든 렌더링 지점이 이것을 사용한다.

```
formatObservationTitle(title: string, gitUser: string | null): string
  → gitUser ? `by ${gitUser}, ${title}` : title
```

적용 대상:

| 계층 | 파일 및 위치 |
| --- | --- |
| 컨텍스트 주입 | `services/context/formatters/HumanFormatter.ts:109,128`<br>`services/context/formatters/AgentFormatter.ts:95,109` |
| CLI | `cli/claude-md-commands.ts:224`<br>`cli/handlers/file-context.ts:129` |
| 검색·타임라인 | `services/worker/search/ResultFormatter.ts:140,192`<br>`services/worker/SearchManager.ts:675,1209,1412,1516,1645`<br>`services/worker/TimelineService.ts:169` |
| 알림 | `services/integrations/TelegramNotifier.ts:41` |
| API | `services/worker/http/routes/DataRoutes.ts:369`<br>`services/worker/http/routes/SearchRoutes.ts:425`<br>`server/runtime/ServerViewerDataRoutes.ts:74,116` |
| UI | `ui/viewer/components/ObservationCard.tsx:95` |

### API 계층은 문자열을 합치지 않는다

`DataRoutes`, `SearchRoutes`, `ServerViewerDataRoutes`는 `gitUser`를 **별도 JSON 필드로**
내보내고, 결합은 `ObservationCard`에서 수행한다. `ui/viewer/types.ts`의 Observation 타입에도
`gitUser: string | null`을 추가한다.

API가 title에 이름을 미리 섞으면 UI에서 작성자만 따로 스타일링하거나 작성자로 필터링할 길이
막힌다. 표시 문자열의 결합은 표시 계층의 책임이다.

## 기존 데이터

백필하지 않는다. 과거 Observation의 실제 작성자를 알아낼 방법이 없고, 현재 값을 채우면 틀린
정보를 만든다. `git_user`가 `NULL`인 Observation은 이름 없이 기존과 동일하게 표시된다.

## 테스트

- **`git-user.ts` 유닛**: `user.name` 설정된 repo / 설정 없는 환경 / 존재하지 않는 cwd /
  개행·공백이 섞인 값 / 64자 초과 값.
- **마이그레이션**: 컬럼이 없는 기존 DB에 추가되는지, 재실행이 멱등한지.
- **포맷터**: `gitUser`가 있을 때와 `null`일 때 양쪽 출력.
- **전달 경로**: 훅 → 세션 저장 → Observation 복사가 로컬 경로에서 이어지는지 확인하는 통합 테스트.

## 리스크

- **토큰 증가**: Observation당 약 4~6토큰. 컨텍스트에 50개가 주입되면 세션당 200~300토큰이
  늘어난다.
- **훅 지연**: 세션 시작당 `execFileSync` 1회. 대략 5~15ms로 예상하나 **구현 후 실측하여
  보고한다**. 세션당 1회이므로 체감되지 않을 것으로 판단한다.
- **프라이버시**: git user.name이 Observation에 기록되어 server-beta로 전송된다. 팀 공유가
  이 기능의 목적이므로 의도된 동작이다.

## 범위 밖

- 작성자 기준 검색/필터 기능. 저장 구조(전용 컬럼 + 인덱스)가 이를 가능하게 하지만, 이번
  범위에는 포함하지 않는다.
- 작성자 표시를 끄는 설정 옵션.
- `user.email` 저장. 이번에는 `user.name`만 저장한다.
- 기존 Observation 백필.
