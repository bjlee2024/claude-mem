# 멀티소스 통합 로그 console 설계

- 작성일: 2026-06-29
- 상태: 설계 승인 완료 (구현 plan 대기)
- 관련 런타임: server-beta (Docker), client

## 1. 배경 & 문제

web viewer 하단 console(`LogsDrawer`, `App.tsx`의 "Toggle Console")은 component별 로그
필터(`LogsModal.tsx`)를 갖추고 있고, server-beta가 `GET /api/logs`로 in-memory ring
buffer를 서빙한다. 기능 자체는 정상 빌드·배포되어 동작한다.

그러나 사용자 관점에서 "component별 로그가 기록되지 않는 것처럼" 보인다. 검증 결과:

- `GET /api/logs`가 반환하는 데이터는 **server 프로세스의 ring buffer 뿐**이다
  (`Logger.recentLogs`, 메모리 전용). 실측 분포: `SYSTEM`/`SECURITY`만 존재.
- generation **worker는 별도 컨테이너**이며 HTTP를 띄우지 않는다("no HTTP"). worker가
  내는 component 로그는 이 console에 들어오지 않는다.
- **client(호스트) hook**의 `HOOK` 등 로그는 호스트 `~/.claude-mem/logs`에 있고 server로
  전달되지 않는다.
- 부차적으로, UI의 `LogComponent`(9종)는 logger의 실제 `Component`(수십 종)보다 훨씬
  적어 `SECURITY`·`QUEUE` 등이 필터에서 누락된다.

즉 멀티컨테이너/멀티프로세스 구조에서 로그가 **분산**되어 한 console에 모이지 않는 것이
근본 원인이다. 버그가 아니라 데이터 수집 범위의 한계다.

## 2. 목표 / 비목표

### 목표
- web console 한 곳에서 **server + worker + client** 세 소스의 로그를 component별로 본다.
- 각 로그 줄의 출처(`source`)를 구분한다.
- client→server 전송량은 설정으로 조절한다(기본 WARN+).
- 기존 폴링 방식(`GET /api/logs` 주기 fetch)과 `LogsDrawer` UI를 그대로 재사용한다.

### 비목표 (YAGNI)
- SSE 실시간 스트리밍.
- 로그 영구 저장/전문 검색.
- client 로그 파일 전체 동기화(미러링).
- worker의 HTTP 서버화.

## 3. 아키텍처 개요

```
[client hook (호스트)]  --push(WARN+, best-effort)-->  POST /api/logs/ingest ┐
                                                                              v
[worker container] --(공유 volume /data/claude-mem/logs/*.log)-- pull/tail --> [server: 통합 로그 store]
                                                                              ^
[server 자기 로그] ----------------------(직접 적재)--------------------------┘
                                                                              |
                                                          GET /api/logs (폴링)|
                                                                              v
                                                              [web viewer: LogsDrawer]
```

- **통합 지점은 server 한 곳**(통합 로그 store).
- worker = **pull**(server가 공유 volume 파일 tail), client = **push**(HTTP ingest),
  server = 직접 적재.

## 4. 컴포넌트 설계

### 4.1 통합 로그 store (server, `src/utils/logger.ts`)
- 현재 `recentLogs: string[]`(평문, MAX 2000)를 **구조화 엔트리 ring**으로 확장한다.
  - 엔트리: `{ ts: string; level: LogLevel; component: Component; source: LogSource; message: string }`
  - `LogSource = 'server' | 'worker' | 'client'`
- server 자기 로그는 `Logger.log()`에서 `source='server'`로 자동 적재(현행 유지).
- 크기 상한 확대(예: 5000). 반환 시 `ts` 기준 정렬.
- `getRecentLogs()`는 통합 엔트리를 직렬화(기존 텍스트 포맷 + source 태그)해 반환.
- 외부(worker tail / client ingest)에서 엔트리를 주입하는 `ingestExternal(entries, source)` 추가.

### 4.2 worker 로그 수집 — pull (server)
- 전제(확인됨): worker는 `CLAUDE_MEM_DATA_DIR=/data/claude-mem`에 로그 파일을 쓰며,
  server와 `claude-mem-data` volume을 공유한다.
- server가 `/data/claude-mem/logs/*.log`(최신 파일)의 **새 라인을 offset 추적하며 tail**한다.
  - 트리거: 경량 주기 타이머(예: 2~5초) 또는 `GET /api/logs` 요청 시 갱신.
  - 파싱: 기존 라인 포맷 `[ts] [level] [component] message` → 엔트리, `source='worker'`.
  - 중복 방지: 파일별 바이트 offset 저장.
- server 자신도 같은 파일에 쓰는 경우 자기 라인은 제외(이미 store에 있음) — 파싱 시
  source 판별 또는 server는 파일 미기록 전제 확인(현 logger 주석상 server-beta는 stdout 전용).

### 4.3 client 로그 전송 — push (client → server)
- client `Logger`가 in-process 로그 라인을 누적(레벨 게이트: `CLAUDE_MEM_LOG_FORWARD_LEVEL`, 기본 `WARN`).
- hook 종료 시점(hook-io의 flush 경로와 동일 타이밍)에 누적 배치를 **`POST /api/logs/ingest`로 전송**.
  - best-effort: 비동기, 실패 무시(기존 spool/이벤트 전송과 동일 철학 — hook 성능·정상흐름에 영향 없음).
  - 인증: 기존 `CLAUDE_MEM_SERVER_BETA_API_KEY` 사용.
  - 배치 상한(예: 200줄/요청), 빈 배치는 미전송.
- server는 수신 엔트리를 `source='client'`로 store에 머지.

### 4.4 API (`src/server/runtime/ServerViewerDataRoutes.ts`)
- `GET /api/logs` (기존, line 149): 통합 store 반환. 응답에 source 포함(텍스트 포맷 유지 +
  선택적으로 구조화 JSON 필드).
- `POST /api/logs/ingest` (신규): client 배치 수신. `requireServerAuth`로 보호. body =
  `{ entries: LogEntry[] }`. 검증 후 `ingestExternal(..., 'client')`.
- `POST /api/logs/clear` (기존, line 150): 통합 store clear.

### 4.5 UI (`src/ui/viewer/components/LogsModal.tsx`)
- `LogComponent` 목록을 logger의 `Component`와 **동기화**(누락된 `SECURITY`·`QUEUE`·`GIT`·
  `ENV` 등 보강). 단일 출처 상수로 관리하거나 server에서 component 목록을 받는 방식 고려.
- 각 줄에 `source` 배지(server/worker/client) 표시 + source 필터 토글 추가.
- 파싱 로직이 source 태그를 인식하도록 확장.

### 4.6 설정
- `CLAUDE_MEM_LOG_FORWARD_LEVEL` (기본 `WARN`): client→server 전송 최소 레벨.
- worker tail 주기/배치 상한은 상수 또는 env(기본값 보유).

## 5. 데이터 흐름 요약
1. server 로그 → store(server) 자동.
2. worker 로그 → 파일 → server tail → store(worker).
3. client 로그 → 레벨 게이트 → hook 종료 시 POST → store(client).
4. viewer → `GET /api/logs` 폴링 → 통합·정렬된 줄 + source/component 필터 표시.

## 6. 에러 처리 & 안전
- client push 실패는 무시(로그 누락은 허용, 정상 흐름 차단 금지).
- worker 파일 부재/파싱 실패 라인은 skip하고 계속.
- `POST /api/logs/ingest`는 인증 필수, body 크기/줄 수 상한으로 남용 방지.
- store ring 상한으로 메모리 무한 증가 방지.

## 7. 테스트 전략
- 단위: 라인 파서(포맷→엔트리), 레벨 게이트, ring 상한/정렬, ingest 검증.
- 통합: worker 파일에 라인 추가 → `GET /api/logs`에 `source=worker`로 등장. ingest POST →
  `source=client`로 등장. 인증 없는 ingest는 거부.
- UI: component/source 필터가 각 소스 줄을 올바르게 보여주는지(가능 범위에서).

## 8. 배포
- server·client 코드 변경 → 빌드. **Docker server 이미지 재빌드 필요**(현 실행본 13.4.22).
- `npm run build-and-sync`로 호스트 plugin(client) 갱신, `docker compose ... up -d --build`로
  server/worker 컨테이너 갱신.

## 9. 영향 파일(예상)
- `src/utils/logger.ts` — 엔트리 store, source, ingestExternal, 레벨 게이트 훅.
- `src/server/runtime/ServerViewerDataRoutes.ts` — `/api/logs` 확장, `/api/logs/ingest` 신규.
- server 측 worker 파일 tail 수집기(신규 모듈, 예: `src/server/runtime/WorkerLogCollector.ts`).
- client 로그 전송기(신규/기존 client 전송 클라이언트 확장) + hook 종료 flush 연결.
- `src/ui/viewer/components/LogsModal.tsx` — component 동기화, source 배지/필터.
- 설정 기본값(`SettingsDefaultsManager` 등) — `CLAUDE_MEM_LOG_FORWARD_LEVEL`.
