# 세션 단위 관측 기록 일시 중지

작성일: 2026-08-12
상태: 설계 승인됨

## 목표

작업 도중 슬래시 커맨드 하나로 **현재 세션의 관측 기록만** 멈춘다. 컨텍스트 주입은 그대로
유지되므로 과거 기억은 계속 받으면서 지금 하는 일만 남기지 않는다.

```
/claude-mem:pause    현재 세션의 기록 중단
/claude-mem:resume   다시 기록
```

민감한 작업을 하거나, 실험적인 삽질을 기억에 남기고 싶지 않을 때 쓴다.

## 왜 기존 옵션으로는 안 되는가

`CLAUDE_MEM_EXCLUDED_PROJECTS`와 `CLAUDE_MEM_INTERNAL=1`이 이미 있지만 둘 다
`shouldTrackProject`를 타고, 그 함수는 네 개 훅 **전부**에서 걸린다.

| 훅 | 핸들러 | 방향 |
| --- | --- | --- |
| `UserPromptSubmit` | `session-init` | 받기 (세션 생성 + 컨텍스트 주입) |
| `PreToolUse` | `file-context` | 받기 (파일 관련 기억 주입) |
| `PostToolUse` | `observation` | 보내기 |
| `Stop` | `summarize` | 보내기 |

그래서 기존 옵션을 켜면 기록도 끊기고 컨텍스트도 끊긴다. 이 설계가 필요한 이유는 정확히 그
비대칭 — 받기는 유지하고 보내기만 끊는 것 — 때문이다.

## 조사로 확인된 사실

1. **`CLAUDE_CODE_SESSION_ID` 환경변수가 존재하고, 훅이 받는 세션 ID와 같은 값이다.** 실측으로
   대조했다: 환경변수 값 `da85bd75-a67d…`가 `server_sessions.external_session_id`의 최신 행과
   일치한다. 이것이 없었다면 슬래시 커맨드가 "어느 세션을 멈출지" 특정할 수 없어 설계 자체가
   성립하지 않는다.
2. `observation` 핸들러와 `summarize` 핸들러 모두 세션 ID를 갖고 있다
   (`observation.ts`의 `sessionId`, `summarize.ts`의 `input.sessionId`).
3. `shouldTrackProject` 검사는 `observation.ts:59`와 `summarize.ts:19`에 있다. 새 검사는 그
   바로 뒤에 놓는다.
4. `~/.claude-mem/`에 `project-map.json` 등 상태 파일을 두는 관례가 이미 있고, 경로 상수는
   `src/shared/paths.ts`에 모여 있다.
5. `src/npx-cli/index.ts`에 `install` / `repair` / `start` 등 서브커맨드 분기 구조가 있다.

## 결정 사항

| 항목 | 결정 |
| --- | --- |
| 커맨드 | `pause` / `resume` 두 개. 토글 아님 |
| 중단 범위 | 도구 기록(`PostToolUse`)과 세션 요약(`Stop`) 둘 다 |
| 유지 범위 | 컨텍스트 주입(`session-init`, `file-context`)은 건드리지 않음 |
| 해제 시점 | 세션 종료 시 자동. 명시적 `resume`도 가능 |
| 상태 조작 주체 | CLI 서브커맨드. 스킬은 호출만 한다 |

### 토글이 아니라 두 개인 이유

기록 중단은 실수하면 되돌리기 어렵다 — 안 남긴 관측은 나중에 복구할 수 없다. 토글은 현재
상태를 모르면 어느 방향으로 가는지 헷갈리므로, 의도한 방향을 명시하는 편이 안전하다.

### 세션 요약까지 멈추는 이유

요약만 남으면 "이 세션에서 무엇을 했는지"가 그대로 기록된다. 도구 기록만 감추고 요약을 남기면
중단한 의미가 없다.

### 상태 조작을 CLI로 옮기는 이유

스킬은 프로세이고, 그 지시를 따르는 것은 에이전트다. JSON 파일을 읽고 고쳐 쓰는 일을 프로세로
지시하면 에이전트가 파일을 통째로 다시 쓰다가 형식을 깨거나 다른 항목을 지울 수 있다. 실제로
직전 작업(`filter` 스킬)에서 프로세로 지시한 계산이 틀린 전례가 있다. 읽기·수정·쓰기를 코드로
옮기면 원자적으로 처리되고 테스트할 수 있으며, 스킬에는 "CLI를 부르고 결과를 전달한다"는 얇은
지시만 남는다.

## 상태 파일

`~/.claude-mem/paused-sessions.json`. 경로 상수는 `src/shared/paths.ts`에 추가한다.

```json
{
  "da85bd75-a67d-4b51-97fb-0252827b36e6": 1786500000000
}
```

세션 ID를 키로, 일시 중지한 시각(epoch ms)을 값으로 둔다. 타임스탬프는 TTL 정리에 쓴다.

파일이 없거나 JSON이 깨졌으면 **빈 객체로 취급하고 계속 진행한다.** 상태 파일 하나 때문에 훅이
실패해 사용자의 작업을 막아서는 안 된다.

## 모듈: `src/shared/session-pause.ts` (신규)

```
isSessionPaused(sessionId: string | null | undefined): boolean
pauseSession(sessionId: string): void
resumeSession(sessionId: string): void
```

- `isSessionPaused`는 훅이 매 이벤트마다 호출하므로 실패해도 예외를 던지지 않는다. 읽기 오류는
  `false`(중단 아님)로 처리한다 — 상태를 못 읽었다고 기록을 멈추면, 사용자가 켜지도 않은 중단이
  조용히 걸린다.
- 세 함수 모두 읽는 시점에 **24시간이 지난 항목을 함께 제거한다.** `Stop` 훅이 불리지 않는
  경우(강제 종료, 크래시)를 위한 안전망이다. 이것이 없으면 파일이 무한히 자란다.

## 훅 적용

### `observation.ts`

`shouldTrackProject` 검사(`:59`) 바로 다음에 추가한다.

```typescript
    if (isSessionPaused(sessionId)) {
      logger.debug('HOOK', 'Session paused, skipping observation', { sessionId, toolName });
      return { continue: true, suppressOutput: true };
    }
```

### `summarize.ts`

`shouldTrackProject` 검사(`:19`) 바로 다음에 추가한다. **순서가 중요하다.**

```typescript
    if (isSessionPaused(input.sessionId)) {
      // Stop fires at session end, so this is where the pause entry gets cleaned
      // up. Clear first, then skip — reversing the order leaves the entry behind
      // forever, because the early return would run before the cleanup.
      resumeSession(input.sessionId);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }
```

정리를 먼저 하고 요약을 건너뛴다. 반대로 하면 조기 반환에 걸려 항목이 영원히 남는다.

## CLI

`src/npx-cli/index.ts`의 서브커맨드 분기에 `session`을 추가한다.

```
npx @bjlee2024/claude-mem session pause <sessionId>
npx @bjlee2024/claude-mem session resume <sessionId>
npx @bjlee2024/claude-mem session status <sessionId>
```

`status`는 스킬이 현재 상태를 사용자에게 알려줄 때 쓴다. 세 명령 모두 사람이 읽을 수 있는 한 줄을
출력한다.

세션 ID는 인자로 받는다. CLI가 환경변수를 직접 읽지 않는 이유는, CLI가 실행되는 프로세스와 실제
세션이 다를 수 있기 때문이다. 값을 넘기는 쪽(스킬)이 자기 세션을 안다.

## 스킬

`plugin/skills/pause/SKILL.md`와 `plugin/skills/resume/SKILL.md` 두 개. 각각 하는 일:

1. `$CLAUDE_CODE_SESSION_ID`로 현재 세션 ID를 얻는다. 비어 있으면 그 사실을 사용자에게 알리고
   중단한다 — 세션을 특정하지 못한 채 추측해서 조작하면 안 된다.
2. `session pause`(또는 `resume`)를 그 ID로 호출한다.
3. 결과를 사용자에게 전한다. **무엇이 멈추고 무엇이 계속되는지 명시한다** — 도구 기록과 세션
   요약은 중단되고, 컨텍스트 주입은 계속되며, 이미 기록된 관측은 그대로 남는다는 것.

`pause` 스킬은 세션이 끝나면 자동으로 풀린다는 점도 함께 알린다. 그래야 사용자가 다음 세션에서
"아직 꺼져 있나?" 하고 헷갈리지 않는다.

## 테스트

- **`session-pause.ts` 단위**: 추가/제거/조회, 파일 없음, 깨진 JSON, 24시간 지난 항목이 읽을 때
  사라지는지, 지나지 않은 항목은 남는지.
- **`isSessionPaused`의 실패 처리**: 읽기 오류에서 `false`를 반환하고 예외를 던지지 않는지.
- **훅 회귀**: 중단 상태에서 `observation`과 `summarize`가 조기 반환하고, `session-init`은
  영향받지 않는지. 후자가 이 기능의 핵심 비대칭이므로 반드시 테스트로 고정한다.
- **`summarize`의 정리 순서**: 중단 상태로 `Stop`을 태우면 항목이 제거되는지. 순서를 뒤집으면
  실패하는 형태여야 한다.

## 리스크

- **중단한 줄 잊는 것.** 세션 종료 시 자동 해제되므로 다음 세션까지 번지지는 않는다. 다만 긴
  세션에서는 한참 기록이 비게 되므로, 스킬 출력에서 상태를 분명히 말한다.
- **`Stop`이 불리지 않는 경우.** 24시간 TTL이 받아낸다. 그 사이 같은 세션이 재개되면 여전히
  중단 상태인데, 이는 의도한 동작이다.
- **`CLAUDE_CODE_SESSION_ID`에 대한 의존.** Claude Code가 제공하는 값이라 이 프로젝트가
  통제하지 못한다. 사라지면 스킬이 동작을 멈추지만, 값이 없을 때 조작하지 않고 알리는 쪽으로
  설계했으므로 잘못된 세션을 건드리지는 않는다.

## 범위 밖

- 이미 기록된 관측을 지우는 것. "지금부터 안 남기기"와 "이미 남은 것 지우기"는 다른 요구다.
- 프로젝트 단위 영구 읽기 전용 모드.
- 컨텍스트 주입을 끄는 옵션. 이 기능의 목적과 반대다.
- 다른 세션을 원격으로 중단하는 것. 커맨드는 자기 세션만 다룬다.
