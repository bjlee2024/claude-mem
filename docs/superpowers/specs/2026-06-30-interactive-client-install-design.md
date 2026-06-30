# 인터랙티브 인스톨러 Client 옵션 추가 — 설계

- 날짜: 2026-06-30
- 브랜치: `feat/interactive-client-install`

## 배경 / 문제

중앙 server-beta(`/v1` REST) 머신의 메모리를 다른 머신에서 공유하려면 그 머신을
`client` 런타임으로 설치해야 한다(worker 모드는 `/api/*`만 알아 server-beta에
도달하지 못함). 그러나 인터랙티브 인스톨러의 런타임 선택지에는 `worker`와
`server-beta`만 노출되어 있고 `client`가 없다(`install.ts:737-744`). 그래서 다른
머신은 worker로 설치되어 로컬 빈 DB를 보고 "no memory yet"이 뜬다.

`client` 모드 자체는 이미 코드에 완전히 구현되어 있다:
- `setupClientRuntime(serverUrl, apiKey)` — 0600 settings 저장 + `/v1/info`
  best-effort preflight (`install.ts:800`)
- `resolveInstallMode` 의 `client` 분기 — `--mode client --enroll <token>` 경로
  (`install.ts:1213-1224`)
- 이후 흐름(autostart skip, "Configuring remote client" 태스크, client 전용
  next-steps + early return)이 `selectedRuntime === 'client'` 가드로 이미 처리됨
  (`install.ts:1547-1548, 1554-1559, 1660-1687`)

즉 빠진 것은 **인터랙티브 select에서 client를 고를 수단**과, 고른 뒤 **enroll
토큰을 디코드해 `resolved.serverUrl/apiKey`를 채우는 연결부**뿐이다.

## 설계

### 변경 지점 (3곳, surgical)

1. **`promptRuntime` select에 `client` 추가** (`install.ts:713-759`)
   - 반환 타입을 `RuntimeId` → `RuntimeId | 'client'` 로 확장
   - select 옵션 추가: `{ value: 'client', label: 'Client', hint: 'connect to a remote claude-mem server' }`
   - `client` 선택 시 promptRuntime 내부에서는 settings를 미리 쓰지 않고 `'client'`만
     반환한다(부분 설정 방지 — 토큰 확정 후 호출부에서 setupClientRuntime이 기록).

2. **client 선택 시 enroll 토큰 입력 → 디코드 → resolved 갱신 → setupClientRuntime**
   (호출부 `install.ts:1395` else 블록; `--mode client` 의 `isClientMode` 처리와 대칭)
   - `p.text({ message: 'Paste your enrollment token (from `server enroll`):', validate })`
   - `validate` 콜백에서 `decodeEnrollment(value)` 를 호출해 잘못된 토큰을
     "Invalid enrollment token" 으로 인라인 거부 → 사용자가 즉시 재입력
   - 확정된 토큰을 디코드해 `{ url, key }` 획득 →
     `resolved.serverUrl = url; resolved.apiKey = key; (runtime은 'client')`
   - `await setupClientRuntime(url, key)` 호출
   - `p.isCancel` 이면 기존 패턴대로 `p.cancel(...) + process.exit(0)`

3. **provider/모델 프롬프트 skip** (`install.ts:1396-1397`)
   - `selectedRuntime === 'client'` 이면 `promptProvider`/`promptClaudeModel` 을
     건너뜀 (client는 로컬 compression provider 불필요 — `--mode client` 와 동일)

### 데이터 흐름

```
[select: Client]
  → p.text(enroll token) --validate--> decodeEnrollment 통과
  → decodeEnrollment(token) = { url, key }
  → resolved.serverUrl/apiKey 갱신, selectedRuntime = 'client'
  → setupClientRuntime(url, key)   // 0600 저장 + /v1/info preflight
  → 기존 가드들이 worker/SQLite/Chroma 셋업 자동 skip
  → client 전용 Next Steps 출력 (early return)
```

### 에러 처리 (기존 패턴 재사용)

- 잘못된 토큰: `p.text` validate에서 즉시 거부 → 재입력 (별도 retry 루프 불필요)
- 입력 취소: `p.isCancel` → `process.exit(0)`; 토큰 확정 전에는 어떤 settings도
  쓰지 않아 부분 설정이 남지 않음
- 서버 도달 실패: `setupClientRuntime` 의 best-effort WARN (설치 완료, 런타임 재시도)

## 범위 밖 (YAGNI)

- `--runtime client` 비인터랙티브 플래그 (이미 `--mode client` 로 존재)
- 인터랙티브 URL+token 직접 입력 (enroll 토큰으로 충분)
- 비-TTY / `--runtime` 경로 (기존대로 worker, 변경 없음)

## 테스트

- 신규 순수 헬퍼 `enrollmentToClientInstall(token)` (가칭): enroll 토큰 →
  `{ runtime: 'client', serverUrl, apiKey }` 매핑. 잘못된 토큰은 throw. 이 헬퍼에
  단위 테스트를 추가한다(정상 토큰 / 깨진 토큰).
- `decodeEnrollment` 는 기존 검증됨.
- 인터랙티브 `p.select` / `p.text` 자체는 기존 관례대로 단위 테스트 없음(수동 검증).

## 검증 (수동)

`CLAUDE_MEM_RUNTIME` 미설정 머신에서 `npx ... install` → 인터랙티브로 Client 선택 →
유효 토큰 입력 → settings에 `CLAUDE_MEM_RUNTIME=client` + `SERVER_BETA_URL/API_KEY`
기록 확인, provider 프롬프트가 뜨지 않고 worker/SQLite/Chroma 셋업이 skip되는지 확인.
