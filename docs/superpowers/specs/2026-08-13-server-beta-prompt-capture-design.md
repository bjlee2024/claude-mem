# server-beta 사용자 프롬프트 저장 및 조회

작성일: 2026-08-13
상태: 설계 승인됨

## 목표

server-beta 런타임에서 사용자 프롬프트를 전부 저장하고, 뷰어의 `/api/prompts`로 조회할 수
있게 한다. 동시에 `/claude-mem:pause`가 프롬프트 기록도 멈추도록 연결한다.

## 현재 상태 — 왜 필요한가

**저장이 반쪽이다.** server-beta는 프롬프트를 `server_sessions.metadata.prompt`에 넣는데,
`session-init` 훅은 프롬프트마다 실행되지만 `/v1/sessions/start`가 기존 세션이면 조기 반환하고
metadata를 갱신하지 않는다. 그래서 **세션의 첫 프롬프트 하나만** 남는다.

실측으로 확인했다. 이 저장소 작업 세션(`da85bd75`, 08-10 09:06 시작)에는 프롬프트가 하나 —
그 대화의 첫 질문 — 만 저장되어 있고, 이후 수십 개의 프롬프트는 어디에도 없다. 전체로는
세션 509개 중 193개에 프롬프트가 있으며 각 1개씩, 길이는 3~3,230자(평균 256자)로 원문 그대로다.

**조회가 아예 없다.** 서버 뷰어의 `/api/prompts`는 하드코딩된 빈 배열을 반환한다
(`ServerViewerDataRoutes.ts:146-149`). 뷰어 UI에 `PromptCard.tsx`가 있지만 채울 데이터가 오지
않는다. postgres에는 `user_prompts` 테이블 자체가 없다.

로컬 worker(sqlite)는 다르다. `user_prompts` 테이블에 프롬프트마다 행이 쌓이고 FTS5 인덱스가
붙으며, `SearchManager`가 검색 결과에 관측·요약과 함께 섞어서 반환한다. **두 런타임의 데이터가
근본적으로 다르다.**

## 조사로 확인된 사실

1. `agent_events.event_type`은 자유 문자열이다. 현재 `tool_use` 48,210건, `assistant_message`
   2,270건, `observation.created` 8건이 쌓여 있다.
2. 클라이언트에 `generate` 플래그가 이미 있다 — `input.generate === false`면
   `/v1/events?generate=false`로 보내 관측 생성 job을 만들지 않는다
   (`server-beta-client.ts`의 `recordEvent`).
3. 이벤트↔세션 연결은 `contentSessionId`로 자동 처리된다(13.8.1에서 추가). 프롬프트 이벤트도
   같은 경로를 탄다.
4. 서버 뷰어는 이미 `id`를 UUID 문자열로 내보낸다(`ServerViewerDataRoutes.ts:24,45`). 뷰어의
   TS 타입은 `id: number`지만 런타임에는 문제가 되지 않는다. 프롬프트도 같은 방식이면 일관된다.
5. `isSessionPaused`는 `observation.ts`와 `summarize.ts`에서만 참조된다. `session-init`은
   중단의 영향을 받지 않는다.

## 결정 사항

| 항목 | 결정 |
| --- | --- |
| 저장 경로 | `agent_events`에 `event_type = 'user_prompt'`로 기록 |
| 관측 생성 | `generate: false` — 프롬프트는 관측을 만들지 않는다 |
| 세션 metadata | 기존 `prompt` 필드는 그대로 둔다 |
| 조회 | `/api/prompts`를 `agent_events`에서 채운다 |
| pause 연동 | 프롬프트 이벤트 전송만 중단. 세션 생성과 컨텍스트 주입은 유지 |

### `agent_events` 재사용을 택한 이유

검토한 대안은 셋이었다.

- **`user_prompts` 테이블 신설**: 로컬 sqlite와 대칭이 되고 의미가 명확하다. 그러나 postgres
  마이그레이션·리포지토리·라우트가 새로 필요하고, 이 저장소는 마이그레이션 경로가 둘로 갈려
  있어 한쪽만 고치는 실수가 반복된 전례가 있다.
- **세션 metadata를 매번 갱신**: 변경은 가장 작지만 세션 행 하나에 대화 전체가 누적되고,
  배열이 무한히 자라며, 페이지네이션도 정렬도 되지 않는다. 탈락.
- **`agent_events` 재사용 (채택)**: 마이그레이션이 없다. 프로젝트/팀 스코프, 인덱스, 감사
  로그, 세션 연결이 전부 기존 것을 그대로 탄다. `generate=false`라는 정확한 스위치가 이미 있다.

트레이드오프: 이벤트 테이블이 더 커지고(현재 48k), 조회할 때마다 `event_type` 필터가 필요하다.

## 저장

`session-init` 훅이 세션 시작을 알린 뒤, 프롬프트 이벤트를 하나 더 보낸다.

```
recordEvent({
  eventType: 'user_prompt',
  payload: { prompt },
  generate: false,
})
```

`generate: false`가 빠지면 프롬프트마다 LLM 생성 job이 돌아 비용과 노이즈가 생긴다. 이것이
이 설계에서 가장 쉽게 놓칠 수 있는 지점이다.

세션 metadata의 `prompt`는 건드리지 않는다. 첫 프롬프트가 사실상 세션 제목 역할을 하고 있고,
없애면 기존 데이터를 읽던 화면이 깨진다.

## 조회: `/api/prompts`

`ServerViewerDataRoutes.ts:146`의 빈 배열 반환을 실제 조회로 바꾼다. `agent_events`에서
`event_type = 'user_prompt'`인 행을 `occurred_at` 내림차순으로 읽어 매핑한다.

| 뷰어 필드 | 출처 |
| --- | --- |
| `id` | `agent_events.id` |
| `content_session_id` | 연결된 `server_sessions.content_session_id` |
| `project` | 세션 metadata의 `project` |
| `platform_source` | `server_sessions.platform_source` |
| `prompt_text` | `payload->>'prompt'` |
| `created_at_epoch` | `occurred_at`의 epoch ms |
| `prompt_number` | 세션 내 순번 (`row_number()`) |

응답은 기존 `/api/observations`와 같은 `{ items, hasMore, offset, limit }` 형태다.

세션에 연결되지 않은 프롬프트 이벤트(세션 행이 아직 없을 때 도착한 경우)는 `content_session_id`,
`project`, `platform_source`가 비게 된다. 그런 행도 **빠뜨리지 않고 반환한다** — 프롬프트 본문은
있으므로 목록에서 사라지는 편이 더 혼란스럽다.

## pause 연동

`session-init`에서 프롬프트 이벤트 전송만 `isSessionPaused`로 감싼다.

**세션 생성과 컨텍스트 주입은 조건 없이 유지한다.** 중단 중에도 과거 기억은 계속 받아야 하고,
세션 행이 없으면 이후 이벤트가 세션에 연결되지 않아 다른 기능이 깨진다.

이로써 13.10.0에서 문서로만 경고했던 "pause는 프롬프트를 막지 못한다"가 해소된다. 해당 문구를
`docs/public/configuration.mdx`와 `plugin/skills/pause/SKILL.md`에서 갱신한다.

## 테스트

- **이벤트 전송**: `session-init`이 세션 시작 후 `user_prompt` 이벤트를 보내는지, `generate`가
  `false`인지. 후자가 빠지면 비용이 발생하므로 단언으로 고정한다.
- **pause 연동**: 중단 상태에서 프롬프트 이벤트가 전송되지 **않고**, 세션 시작과 컨텍스트 주입은
  평소대로 일어나는지. 이 비대칭이 핵심이므로 대조군을 함께 둔다.
- **`/api/prompts`**: 프롬프트 이벤트만 반환하고 `tool_use`는 섞이지 않는지, 페이지네이션이
  동작하는지, 세션 미연결 행도 반환되는지. 라이브 postgres가 필요한 부분은 배포 후 실제 요청으로
  확인한다.

## 리스크

- **저장량 증가.** 지금은 세션당 1건이지만 앞으로는 프롬프트마다 쌓인다. 이 대화 하나로도 수십
  건이며, 붙여넣은 코드나 로그가 원문 그대로 들어간다. pause 연동이 방어책이지만 pause를 켜지
  않은 평소에는 전부 저장된다.
- **`generate: false` 누락.** 빠뜨리면 프롬프트마다 생성 job이 돌아 조용히 비용이 늘어난다.
  테스트로 고정한다.
- **이벤트 테이블 성장.** `agent_events`가 이미 48k행이다. 프롬프트가 더해져도 `tool_use`에
  비하면 작지만, `/api/prompts` 조회는 `event_type` 필터를 타므로 프로젝트 규모가 커지면
  `(event_type, occurred_at)` 인덱스를 검토한다. 이번 범위에는 넣지 않는다.

## 범위 밖

- **SSE 실시간 반영.** 뷰어에 `new_prompt` 이벤트 타입이 있지만 broadcast 배선은 별개 작업이다.
  새로고침하면 보인다.
- **검색 노출.** 로컬 worker는 `search` 결과에 프롬프트를 섞지만 server-beta에는 넣지 않는다.
  그 혼합이 작성자 필터를 새게 만든 전례가 있어(13.10.0 리뷰), 조회 전용으로 시작한다.
- 세션 metadata의 첫 프롬프트 제거.
- 기존 데이터 백필. 지나간 프롬프트는 어디에도 없으므로 복구할 수 없다.
- 로컬 worker 런타임의 변경. 그쪽은 이미 프롬프트를 저장하고 노출한다.
