# claude-mem 컴포넌트 아키텍처 (Client / Worker / Server)

이 문서는 이 fork(`bjlee2024/claude-mem`)에 맞춤화된 claude-mem의 전체 구조를
**Client · Worker · Server** 세 컴포넌트로 나누어, 각 컴포넌트의 **역할**과
**동작 메커니즘**을 설명한다. 코드 정독(소스 361개 파일) 기준으로 작성되었으며,
경로/식별자는 원문 그대로 둔다.

> 한 줄 정의
> - **Client** — 호스트(Claude Code 등)에 붙어 도구사용을 *캡처*하고 컨텍스트를 *주입*하는 프런트엔드.
> - **Worker** — 도구사용 이벤트를 LLM으로 압축해 *관측(observation)/요약(summary)을 생성*하는 엔진.
> - **Server** — 관측을 *저장·검색·인증·배포*하는 백엔드(멀티테넌트).

---

## 0. 용어 정리 — "Worker"의 중의성

`worker`라는 단어는 코드베이스에서 두 가지를 가리킨다. 혼동을 피하기 위해 먼저 구분한다.

| 용어 | 실체 | 위치 |
|---|---|---|
| **로컬 워커(local worker)** | 올인원 데몬(Express + SQLite + Chroma + 생성 + 뷰어) | `src/services/worker-service.ts` |
| **서버 생성 워커(server generation worker)** | BullMQ 큐를 소비해 관측만 생성하는 프로세스 | `claude-mem server worker start` |

이 문서에서 **"Worker 컴포넌트"** 는 *역할*(= LLM 압축 생성 엔진)을 가리키며,
로컬 워커와 서버 생성 워커 **둘 다**가 그 역할을 수행한다.

---

## 1. 세 가지 배포 모드

claude-mem은 `~/.claude-mem/settings.json`의 `CLAUDE_MEM_RUNTIME` 값으로
세 가지 토폴로지 중 하나로 동작한다. 컴포넌트가 어떻게 합쳐지는지가 모드별로 다르다.

```
worker 모드 (기본, 단일 머신 올인원)
┌──────────────── 한 머신 ────────────────┐
│ Client(훅) → 로컬 워커(생성+저장 내장) → SQLite + Chroma │
│                         └→ 뷰어 :37700+               │
└─────────────────────────────────────────┘

server-beta 모드 (서버 머신에서 직접 운영)
┌──────────────── 서버 머신 ────────────────┐
│ Client(훅) → /v1 REST 서버 → Postgres + BullMQ           │
│                              ↑                          │
│              서버 생성 워커(큐 소비) → Postgres          │
└──────────────────────────────────────────┘

client 모드 (얇은 클라이언트 → 원격 서버)
┌── 개발자 머신 ──┐        ┌──────── 원격 서버 ────────┐
│ Client(훅)      │ ──HTTP→ │ /v1 REST + Postgres + BullMQ │
│ + spool(오프라인)│        │ + 서버 생성 워커            │
└─────────────────┘        └───────────────────────────┘
```

선택 로직: `src/services/hooks/runtime-selector.ts`의 `selectRuntime()` →
`'worker' | 'server-beta' | 'client'`. 원격 모드 구성이 불완전하면(URL/키 누락)
안전하게 `worker`로 폴백한다.

---

## 2. 공통 캡처 파이프라인 (모든 모드 공유)

세 모드 모두 **동일한 Client 측 진입 파이프라인**을 거친 뒤, 마지막 단계에서만 분기한다.

```
호스트 훅 이벤트
  └ plugin/hooks/hooks.json (방어적 셸 프렐류드; src/build/hook-shell-template.ts가 단일 소스로 생성)
  └ bun-runner.js → worker-service.cjs hook <platform> <event>
     └ src/cli/hook-command.ts
        1) readJsonFromStdin()                  — stdin JSON 수집
        2) adapter.normalizeInput()             — 플랫폼별 정규화 (src/cli/adapters/*)
        3) handler.execute()                    — 이벤트 핸들러 (src/cli/handlers/*)
        4) emitModelContext()                   — stdout JSON 1회 방출 (hook-io.ts)
```

호스트 훅 ↔ 핸들러 ↔ 백엔드 경로 매핑:

| 호스트 훅(Claude Code) | 핸들러 | worker 엔드포인트 | 역할 |
|---|---|---|---|
| `SessionStart` | `context` | `GET /api/context/inject` | 과거 관측 컨텍스트 주입 |
| `UserPromptSubmit` | `session-init` | `POST /api/sessions/init` | 세션 등록(+의미검색 주입) |
| `PostToolUse(*)` | `observation` | `POST /api/sessions/observations` | 도구사용 캡처 |
| `PreToolUse:Read` | `file-context` | `GET /api/observations/by-file` | 그 파일의 과거 관측 타임라인 주입 |
| `Stop` | `summarize` | `POST /api/sessions/summarize` | 세션 요약 요청 |
| `Setup` | `version-check.js` | — | 버전 마커 점검, 불일치 시 `repair` 안내 |

**어댑터(`src/cli/adapters/`)**: claude-code, codex, cursor, gemini-cli, windsurf, raw.
플랫폼별 raw 입력을 공통 `NormalizedHookInput`으로 변환한다(잘못된 cwd/세션ID는 `AdapterRejectedInput`로 거부).

**IO 규율(`src/shared/hook-io.ts`)**: 핸들러는 **순수 함수**다 —
`process.stdout/stderr`·`console`·`process.exit`를 직접 호출하지 않고 `HookResult`만 반환한다.
- stdout JSON = **MODEL_CONTEXT**(모델이 소비), `systemMessage` = **USER_HINT**(사람에게 보임),
  stderr = **DIAGNOSTIC**(운영자), exit 2 = **BLOCKING_FEEDBACK**.
- 서드파티 stderr 노이즈는 버퍼링으로 차단하고, 성공 시 버려 "조용한 성공"을 유지한다.

**우아한 저하**: 워커/서버가 닿지 않는 전송 오류(ECONNREFUSED/타임아웃/5xx)는 exit 0으로
**절대 호스트 세션을 막지 않는다**. 진짜 클라이언트 버그(4xx/TypeError)만 exit 2.

---

## 3. Client 컴포넌트

### 역할
호스트(Claude Code, Codex, Cursor, Gemini CLI, Windsurf 등)에 붙어
1. 도구사용/프롬프트/세션 이벤트를 **캡처**하고,
2. 세션 시작 시 과거 관측을 **주입**하는 프런트엔드.
저장이나 LLM 생성은 하지 않는다(그건 Worker/Server의 일).

### 메커니즘

#### (a) 훅 실행 — 모든 모드 공통
2장의 파이프라인이 Client의 본체다. `src/cli/` 전체(어댑터·핸들러·hook-command).

#### (b) thin-client 모드 (`CLAUDE_MEM_RUNTIME=client`)
로컬 워커도 SQLite도 없이, 원격 서버 `/v1/*`로 직접 말한다.
핵심 코드: `src/services/hooks/`.

- **`ServerBetaClient`** (`server-beta-client.ts`) — `/v1` REST 클라이언트.
  `startSession`, `recordEvent`, `endSession`, `searchObservations`,
  `contextObservations`, `resolveProject`, `timelineObservations` 등. Bearer 키 인증,
  전송 오류는 타입드 `ServerBetaClientError`(폴백 가능 여부 판정 포함).
- **`ProjectResolver`** (`project-resolver.ts`) — repo 작업 디렉터리 → 서버 프로젝트 UUID.
  worker 모드와 동일 정책(`getProjectContext(cwd).primary`, git 루트/owner-repo, worktree는
  `parent/worktree` 복합명). `~/.claude-mem/project-map.json`에 name→uuid 캐시 →
  repo당 `POST /v1/projects/resolve` 최대 1회.
- **`ClientWriter`** (`client-write.ts`) — 모든 client 쓰기의 단일 깔때기.
  프로젝트 해석 → 서버 전송 → 실패 시 spool. `sourceEventId`를 idempotency 키로 재사용해
  서버 측 중복 흡수. **훅을 절대 throw로 깨뜨리지 않는다.**
- **`Spool`** (`spool.ts`) — 오프라인 내구 큐. `~/.claude-mem/spool/pending.ndjson`에
  append-only로 쌓고, 다음 훅 호출이 atomic rename으로 가져가 flush. 크래시한 프로세스의
  `.flushing.<pid>` 고아 파일은 PID 생존 확인 후 회수(FIFO 보존).
- **컨텍스트 주입**: `context` 핸들러가 client 모드에서 `client.contextObservations()`로
  서버 관측을 읽어, 서버 row를 `Observation`/`SessionSummary` 형태로 매핑한 뒤
  `renderContextFromObservations()`로 렌더(아래 Worker의 ContextBuilder와 동일 렌더러 공유).

#### (c) MCP 검색 서피스
호스트가 띄우는 MCP 서버(`plugin/.mcp.json` → `mcp-server.cjs`)도 Client 측 구성요소다.
client/server-beta 모드에서 `observation_search`·`observation_context` 등은
`ServerBetaClient`로 서버에 위임된다.

### Client가 만지는 파일/상태
- 코드: `src/cli/**`, `src/services/hooks/**`, `src/servers/mcp-server.ts`
- 상태: `~/.claude-mem/settings.json`, `project-map.json`, `spool/pending.ndjson`

---

## 4. Worker 컴포넌트 (생성 엔진)

### 역할
도구사용 이벤트를 받아 **하드닝된 LLM 세션(Observer)** 으로 압축해
구조화된 관측/요약을 **생성**한다. 이것이 claude-mem의 핵심 가치다.
- worker 모드: 로컬 워커 데몬이 생성+저장+조회+뷰어를 모두 내장.
- server-beta 모드: 서버 생성 워커가 BullMQ 큐를 소비해 생성만 담당.

### 메커니즘 — 생성 파이프라인

```
도구사용 이벤트
  → SessionManager: ActiveSession + SessionMessageBuffer 에 큐잉 (tool_use_id 디둡)
  → Provider.startSession(): 하드닝 SDK 세션 가동
      · buildObservationPrompt(): 도구 입출력을 <observed_from_primary_session>로 감쌈
      · 모드 프롬프트(ModeManager)로 관측 타입/개념/포맷 지시
  → SDK 출력
  → classifyObserverOutput(): idle | prose | poisoned | xml 분류
  → parseAgentXml(): <observation>…</observation> / <summary>…</summary> 파싱
  → ResponseProcessor:
      · 커밋 해시 환각 검증(verifyCommitHashesInText) — 날조 해시 제거
      · 저장(관측/요약) + Chroma 동기화 + SSE 브로드캐스트
```

#### 핵심 하위 컴포넌트 (`src/services/worker/`)
- **LLM 프로바이더 추상화** — `ClaudeProvider`(Agent SDK 서브프로세스),
  `GeminiProvider`(REST), `OpenRouterProvider`(OpenAI 호환). 동일 `startSession` 계약.
  오류는 `ClassifiedProviderError`(`transient`/`rate_limit`/`quota_exhausted`/`auth_invalid`/`unrecoverable`)로
  분류 → retry/abort/fallback 결정(`retry.ts`, `FallbackErrorHandler`). `model-aliases.ts`의
  `$TIER:fast|smart|summary` 별칭, `RateLimitStore`가 구독 쿼터 게이팅.
- **SessionManager / SessionMessageBuffer** — 활성 세션 인메모리 관리. 버퍼는 **휘발성**이며
  복구는 트랜스크립트 재생에 의존. idle 타임아웃(기본 3분)으로 서브프로세스 종료,
  연속 무효 출력 3회 또는 poisoned 감지 시 세션 respawn.
- **하드닝 SDK 옵션** (`src/sdk/hardened-options.ts`) — Observer가 어떤 도구도 못 쓰도록
  6중 방어: `tools:[]`, `allowedTools:[]`, `disallowedTools:[...]`, `permissionMode:'dontAsk'`,
  `canUseTool`(모든 시도 감사), 파일시스템/ MCP 격리. 시도는 `observer-audit.log`에 기록.
- **검색** (`worker/search/`) — `SearchOrchestrator`가 쿼리 유형에 따라 전략 선택:
  `SQLiteSearchStrategy`(메타데이터), `ChromaSearchStrategy`(의미), `HybridSearchStrategy`(혼합).
- **지식/코퍼스** (`worker/knowledge/`) — `CorpusBuilder`로 관측을 묶어 `KnowledgeAgent`(하드닝 SDK)가
  질의응답하는 "브레인" 기능.

#### 로컬 워커 데몬 생명주기 (worker 모드 전용)
`src/services/worker-service.ts` + `worker-spawner.ts` + `worker-shutdown.ts` + `restart-verify.ts`.
- **단일 스포너 보장**: spawn-gate 락(`worker-spawn-gate.ts`)으로 hook/MCP/CLI 중 하나만 스폰.
- **버전 재활용**: 살아있는 워커가 구버전이면 `POST /api/admin/restart`로 1회 재활용(훅당 1회 제한),
  죽는 워커가 자기 **후계자를 직접 스폰**(restart handoff)해 포트 경쟁 방지.
- **PID 파일은 진단용**: 포트 점유가 진실. 삭제는 owner-or-dead 가드(후계자 보호).
- **Supervisor**(`src/supervisor/`): 프로세스 레지스트리(`supervisor.json`), PID 재사용 감지,
  헬스체커, 우아한 종료 캐스케이드(SIGTERM→SIGKILL), 동시 SDK 10개 캡.

#### 서버 생성 워커 (server-beta 모드 전용)
`ProviderObservationGenerator`(`src/server/generation/`)가 BullMQ 잡을 처리:
outbox row 잠금 → 프로바이더 호출 → `processGeneratedResponse`가 XML 파싱 →
`observations` 저장 + `observation_sources` 출처 기록 + 감사. HTTP 서버와 **분리된 프로세스**다
(`CLAUDE_MEM_GENERATION_DISABLED`가 켜진 서버는 HTTP만, 생성은 이 워커가 담당).

### Worker가 만지는 파일/상태
- 코드: `src/services/worker/**`, `src/services/worker-service.ts`, `src/sdk/**`,
  `src/services/context/**`, `src/services/sync/**`(Chroma), `src/server/generation/**`
- 상태(worker 모드): `~/.claude-mem/claude-mem.db`, `chroma/`, 로그, PID 파일

---

## 5. Server 컴포넌트 (저장·큐·인증·배포 백엔드)

### 역할
관측을 **저장**하고, 멀티테넌트로 **스코핑·인증**하며, 생성 잡을 **큐잉**하고,
client에게 컨텍스트/검색/타임라인을 **배포**한다.
- worker 모드: 이 역할이 로컬 워커에 *내장*되고 저장소는 SQLite.
- server-beta/client 모드: 독립 백엔드(`src/server/`)로 *분리*되고 저장소는 Postgres.

### 메커니즘 (server-beta: `src/server/`)

#### (a) HTTP 수신 서버 — `ServerBetaService`
Express + `/v1/*` REST. 핵심 엔드포인트:

| 엔드포인트 | 역할 |
|---|---|
| `POST /v1/events`, `/v1/events/batch` | 이벤트 수신 → outbox + 잡 enqueue |
| `POST /v1/sessions/start`, `/v1/sessions/:id/end` | 세션 시작/종료(요약 잡 enqueue) |
| `POST /v1/projects/resolve`, `/v1/projects/rename` | 프로젝트 해석/이름변경·병합 |
| `POST /v1/search`, `/v1/context`, `/v1/timeline` | 검색·컨텍스트·타임라인 조회 |
| `POST /v1/memories` | 직접 관측 삽입(생성 잡 없음) |
| `GET /v1/jobs`, `/v1/jobs/:id` | 생성 잡 상태 조회 |
| `POST /v1/worker-certs` | mTLS 워커 인증서 발급 |
| `GET /v1/info`, `/healthz` | 헬스/구성 스냅샷 |

#### (b) outbox 패턴 — 신뢰성의 핵심
이벤트 수신은 트랜잭션으로 **Postgres가 진실(canonical)**, BullMQ 페이로드는 보조(advisory):
1. `agent_events` 삽입 + `observation_generation_jobs`(outbox) 삽입 + 잡 이벤트 로그.
2. 커밋 후 BullMQ에 `queue.add(deterministicJobId, payload)`.
3. Redis 불가 시 outbox는 `queued`로 남고, 부팅 시 `reconcileOnStartup`이 재enqueue.

`SessionGenerationPolicy`로 enqueue 시점 조절: `per-event`(즉시, 기본) /
`debounce`(지연 후 최신만) / `end-of-session`(종료 시 요약만).

#### (c) 큐 — BullMQ 4 레인
`event`, `event-batch`, `summary`, `reindex`. Redis/Valkey 백엔드
(`CLAUDE_MEM_REDIS_URL`, 레인당 동시성 1). 서버 생성 워커(4장)가 이 레인을 소비한다.

#### (d) 인증·테넌시
- better-auth + SHA256 API 키. 스코프: `events:write`, `sessions:write`,
  `observations:read`, `jobs:read`, `certs:issue` 등.
- **테넌트 스코핑**: 모든 읽기/쓰기에 `(team_id, project_id)` 필수. 조회는 scope-first —
  교차 테넌트 접근은 **404**(403 아님). 복합 FK가 스키마 레벨에서 강제.
- enrollment 토큰(`encodeEnrollment`)으로 client에 URL+팀 스코프 키를 한 줄로 배포.

#### (e) 저장소 — Postgres (`src/storage/postgres/`)
핵심 테이블: `teams`, `projects`, `server_sessions`, `agent_events`,
`observations`(+ `content_search` TSVECTOR FTS), `observation_sources`(출처 추적),
`observation_generation_jobs`(outbox), `api_keys`, `worker_certs`, `audit_log`.
idempotency 키는 결정적 SHA256(canonical JSON) → 오프라인/재시도 디둡. JSONB 메타데이터.

#### (f) 뷰어
`ServerViewerRoutes`/`ServerViewerDataRoutes`가 인증 없는 읽기 전용 대시보드 제공.

### worker 모드에서의 Server 역할
로컬 워커가 같은 역할을 SQLite로 수행한다(`src/services/sqlite/`, `src/storage/sqlite/`):
- 테이블: `sdk_sessions`, `observations`, `session_summaries`, `user_prompts`, `pending_messages`.
- WAL 모드, 34개 인라인 마이그레이션, **FTS5 트리거 동기화**,
  `content_hash`(SHA256[:16]) 기반 30초 윈도우 디둡, `SchemaRepair`(손상 시 `.recover`).

---

## 6. 컴포넌트 합성 — 모드별 비교표

| 항목 | worker 모드 | server-beta 모드 | client 모드 |
|---|---|---|---|
| Client(훅) | ✅ 로컬 워커 호출 | ✅ `/v1` 호출 | ✅ `/v1` 호출(+spool) |
| Worker(생성) | 로컬 워커 데몬 내장 | 서버 생성 워커(별도 프로세스) | (원격) 서버 생성 워커 |
| Server(저장) | 로컬 워커 내장, **SQLite** | 백엔드, **Postgres** | (원격) 백엔드, **Postgres** |
| Chroma 벡터 | ✅ 로컬 | (서버 측 FTS/임베딩) | (원격) |
| 뷰어 | `:37700+` 로컬 | 서버 뷰어 | 원격 서버 뷰어 |
| 오프라인 내성 | N/A(로컬) | N/A | ✅ spool |
| 공유 범위 | 단일 머신 | 서버에 붙은 모든 client | 서버에 붙은 모든 client |

> **공유 메커니즘**: server-beta/client 모드에서 관측은 프로젝트(`team_id`, `project_id`)에
> 스코핑되어 Postgres에 저장된다. 같은 서버에 enroll된 다른 client가 **같은 repo**(같은 프로젝트명으로 해석)로
> 작업하면 `SessionStart` 시 `client.contextObservations()`로 그 관측을 주입받는다.
> 즉 **client 간 메모리 공유는 "동일 서버 + 동일 프로젝트명"이 성립할 때** 일어난다.

---

## 7. 컴포넌트 간 계약·불변식 (반드시 준수)

1. **핸들러 순수성** — Client 핸들러는 stdout/stderr/exit 직접 호출 금지, `HookResult`만 반환.
2. **우아한 저하** — Worker/Server 미가용은 절대 호스트 세션을 막지 않는다(exit 0).
3. **단일 스포너** — 로컬 워커 스폰은 spawn-gate 락 경유, 훅당 재활용 1회.
4. **PID 소유권 가드** — PID 파일 삭제 전 pid 일치 검증(후계자 보호).
5. **테넌트 스코핑**(Server/Postgres) — 모든 쿼리에 `(team_id, project_id)`, 교차 접근은 404.
6. **outbox canonical** — Postgres outbox row가 진실, BullMQ는 보조. Redis 장애는 부팅 재조정으로 복구.
7. **idempotency** — 결정적 SHA256 키로 오프라인/재시도 디둡(client `sourceEventId` == 서버 키).
8. **환경 격리**(Worker) — SDK 서브프로세스에 호스트 자격증명 누수 금지(`sanitizeEnv` + `BLOCKED_ENV_VARS`),
   자격증명은 `~/.claude-mem/.env`에서만, spawn 시점 OAuth fresh read.
9. **프라이버시** — `<private>` 등 태그는 LLM 전송 전 스트리핑, 텔레메트리는 화이트리스트(로컬 싱크).
10. **렌더러 공유** — client 모드 주입과 worker 모드 주입은 동일 `renderContextFromObservations`를 쓴다.

---

## 8. 코드 위치 빠른 색인

| 컴포넌트 | 주요 디렉터리 |
|---|---|
| Client(훅/어댑터/핸들러) | `src/cli/`, `src/shared/hook-*.ts` |
| Client(thin-client 런타임) | `src/services/hooks/` |
| Client(MCP) | `src/servers/mcp-server.ts`, `plugin/.mcp.json` |
| Worker(생성 엔진) | `src/services/worker/`, `src/sdk/`, `src/services/context/`, `src/services/sync/` |
| Worker(로컬 데몬 생명주기) | `src/services/worker-service.ts`, `worker-spawner.ts`, `worker-shutdown.ts`, `src/supervisor/` |
| Worker(서버 생성) | `src/server/generation/` |
| Server(REST/런타임) | `src/server/runtime/`, `src/server/routes/v1/` |
| Server(큐/잡) | `src/server/jobs/`, `src/server/queue/` |
| Server(인증) | `src/server/auth/`, `src/server/middleware/` |
| Server(저장 - Postgres) | `src/storage/postgres/` |
| Server(저장 - SQLite/worker) | `src/services/sqlite/`, `src/storage/sqlite/` |
| 설치/배포 | `src/npx-cli/` |
| 뷰어 UI | `src/ui/viewer/` (React) |
| 훅 배선(셸 템플릿) | `src/build/hook-shell-template.ts`, `plugin/hooks/hooks.json`, `plugin/.mcp.json` |

---

*작성 기준: claude-mem v13.6.0 소스 전체 정독. 동작 검증은 본 fork의 로컬 server-beta(`127.0.0.1:37700`,
client 모드)에서 실시간 관측 생성·조회로 확인함.*
