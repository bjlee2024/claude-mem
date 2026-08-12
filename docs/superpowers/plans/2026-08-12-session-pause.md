# 세션 단위 관측 기록 일시 중지 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/claude-mem:pause`와 `/claude-mem:resume`으로 현재 세션의 관측 기록만 멈추고, 컨텍스트 주입은 그대로 유지한다.

**Architecture:** 중단된 세션 ID를 `~/.claude-mem/paused-sessions.json`에 기록하고, `PostToolUse`와 `Stop` 훅이 매 이벤트마다 그 파일을 확인해 조기 반환한다. 상태 조작은 CLI 서브커맨드가 담당하고 스킬은 호출만 한다 — JSON 읽기·수정·쓰기를 프로세로 지시하면 에이전트가 파일을 깨뜨릴 수 있다. 세션 ID는 `CLAUDE_CODE_SESSION_ID` 환경변수에서 얻으며, 이 값이 훅이 받는 세션 ID와 동일함은 실측으로 확인했다.

**Tech Stack:** TypeScript, Bun (`bun test`), Node fs

**설계 문서:** `docs/superpowers/specs/2026-08-12-session-pause-design.md`

## Global Constraints

- 중단 대상은 `PostToolUse`(관측)와 `Stop`(세션 요약) **둘 다**. `session-init`과 `file-context`는 **건드리지 않는다** — 컨텍스트 주입 유지가 이 기능의 핵심이다.
- `isSessionPaused`는 **절대 예외를 던지지 않는다.** 파일 없음, 깨진 JSON, 권한 오류 모두 `false`(중단 아님)를 반환한다. 상태를 못 읽었다고 기록을 멈추면 사용자가 켜지도 않은 중단이 조용히 걸린다.
- `summarize`에서는 **정리를 먼저 하고 요약을 건너뛴다.** 순서를 뒤집으면 조기 반환에 걸려 항목이 영원히 남는다.
- 만료 기준은 24시간. `Stop`이 불리지 않는 경우(강제 종료)의 안전망이다.
- 상태 파일 쓰기는 원자적이어야 한다(임시 파일 → rename). `src/npx-cli/utils/paths.ts`의 `writeJsonFileAtomic`을 쓰지 **않는다** — `shared`가 `npx-cli`를 의존하면 계층 방향이 뒤집힌다. 모듈 안에서 직접 처리한다.
- 스킬은 세션 ID를 얻지 못하면 **아무것도 조작하지 않고** 그 사실을 알린다.
- 소스 주석은 영어, 문서는 한국어. 새 의존성 없음.

## File Structure

**신규**
- `src/shared/session-pause.ts` — 상태 파일 읽기/쓰기와 만료 처리. 단일 책임.
- `src/npx-cli/commands/session.ts` — `session pause|resume|status` 서브커맨드
- `plugin/skills/pause/SKILL.md`, `plugin/skills/resume/SKILL.md`
- `tests/shared/session-pause.test.ts`
- `tests/npx-cli/session-command.test.ts`

**수정**
- `src/shared/paths.ts:52` 부근 — `PAUSED_SESSIONS_PATH` 상수
- `src/cli/handlers/observation.ts:59` 다음 — 중단 검사
- `src/cli/handlers/summarize.ts:19` 다음 — 정리 후 중단 검사
- `src/npx-cli/index.ts` — `session` 분기

---

### Task 1: `session-pause` 모듈

**Files:**
- Create: `src/shared/session-pause.ts`
- Modify: `src/shared/paths.ts`
- Test: `tests/shared/session-pause.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `isSessionPaused(sessionId: string | null | undefined): boolean`
  - `pauseSession(sessionId: string): void`
  - `resumeSession(sessionId: string): void`
  - `PAUSED_SESSIONS_PATH` (from `src/shared/paths.ts`)

- [ ] **Step 1: 경로 상수 추가**

`src/shared/paths.ts`에서 `DB_PATH` 선언 아래에 추가한다.

```typescript
export const PAUSED_SESSIONS_PATH = join(DATA_DIR, 'paused-sessions.json');
```

- [ ] **Step 2: 실패하는 테스트 작성**

`tests/shared/session-pause.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// The module reads its path from paths.ts, which derives from CLAUDE_MEM_DATA_DIR.
// Point that at a temp dir before importing so each test gets a clean state file.
let dir: string;
const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sp-'));
  process.env.CLAUDE_MEM_DATA_DIR = dir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

async function load() {
  // Re-import per test so PAUSED_SESSIONS_PATH picks up the temp data dir.
  const mod = await import('../../src/shared/session-pause.js?t=' + Math.random());
  return mod;
}

describe('session-pause', () => {
  it('상태 파일이 없으면 중단 아님', async () => {
    const { isSessionPaused } = await load();
    expect(isSessionPaused('s1')).toBe(false);
  });

  it('pause 후에는 중단 상태', async () => {
    const { pauseSession, isSessionPaused } = await load();
    pauseSession('s1');
    expect(isSessionPaused('s1')).toBe(true);
  });

  it('다른 세션은 영향받지 않는다', async () => {
    const { pauseSession, isSessionPaused } = await load();
    pauseSession('s1');
    expect(isSessionPaused('s2')).toBe(false);
  });

  it('resume 하면 풀린다', async () => {
    const { pauseSession, resumeSession, isSessionPaused } = await load();
    pauseSession('s1');
    resumeSession('s1');
    expect(isSessionPaused('s1')).toBe(false);
  });

  it('resume은 다른 세션 항목을 지우지 않는다', async () => {
    const { pauseSession, resumeSession, isSessionPaused } = await load();
    pauseSession('s1');
    pauseSession('s2');
    resumeSession('s1');
    expect(isSessionPaused('s2')).toBe(true);
  });

  it('빈 세션 ID는 중단 아님', async () => {
    const { isSessionPaused } = await load();
    expect(isSessionPaused('')).toBe(false);
    expect(isSessionPaused(null)).toBe(false);
    expect(isSessionPaused(undefined)).toBe(false);
  });

  it('깨진 JSON이어도 예외를 던지지 않고 중단 아님으로 처리한다', async () => {
    writeFileSync(join(dir, 'paused-sessions.json'), '{ this is not json');
    const { isSessionPaused } = await load();
    expect(() => isSessionPaused('s1')).not.toThrow();
    expect(isSessionPaused('s1')).toBe(false);
  });

  it('24시간이 지난 항목은 중단으로 보지 않는다', async () => {
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(join(dir, 'paused-sessions.json'), JSON.stringify({ old: stale }));
    const { isSessionPaused } = await load();
    expect(isSessionPaused('old')).toBe(false);
  });

  it('24시간이 안 지난 항목은 유지된다', async () => {
    const recent = Date.now() - 1 * 60 * 60 * 1000;
    writeFileSync(join(dir, 'paused-sessions.json'), JSON.stringify({ fresh: recent }));
    const { isSessionPaused } = await load();
    expect(isSessionPaused('fresh')).toBe(true);
  });

  it('쓰기 시점에 만료 항목이 파일에서 제거된다', async () => {
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(join(dir, 'paused-sessions.json'), JSON.stringify({ old: stale }));
    const { pauseSession } = await load();
    pauseSession('new');
    const saved = JSON.parse(readFileSync(join(dir, 'paused-sessions.json'), 'utf8'));
    expect(Object.keys(saved)).toEqual(['new']);
  });

  it('임시 파일을 남기지 않는다', async () => {
    const { pauseSession } = await load();
    pauseSession('s1');
    expect(existsSync(join(dir, 'paused-sessions.json.tmp'))).toBe(false);
  });
});
```

`CLAUDE_MEM_DATA_DIR`이 `paths.ts`의 데이터 디렉터리를 실제로 좌우하는지 먼저 확인한다 — `resolveDataDir()`(`src/shared/paths.ts:18`)를 읽고, 다른 환경변수를 쓴다면 그 이름으로 테스트를 맞춘다.

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `bun test tests/shared/session-pause.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/session-pause.js'`

- [ ] **Step 4: 모듈 구현**

`src/shared/session-pause.ts`:

```typescript
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { PAUSED_SESSIONS_PATH } from './paths.js';

// Entries older than this are treated as gone. The Stop hook clears an entry at
// session end, but a crash or a force-quit never fires it — without an expiry
// the file would grow forever.
const TTL_MS = 24 * 60 * 60 * 1000;

type PausedMap = Record<string, number>;

function read(): PausedMap {
  try {
    const raw = readFileSync(PAUSED_SESSIONS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PausedMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number') out[key] = value;
    }
    return out;
  } catch {
    // Missing file, malformed JSON, unreadable path — all mean "nothing paused".
    return {};
  }
}

function withoutExpired(map: PausedMap, now: number): PausedMap {
  const out: PausedMap = {};
  for (const [key, pausedAt] of Object.entries(map)) {
    if (now - pausedAt < TTL_MS) out[key] = pausedAt;
  }
  return out;
}

function write(map: PausedMap): void {
  const tmp = `${PAUSED_SESSIONS_PATH}.tmp`;
  try {
    mkdirSync(dirname(PAUSED_SESSIONS_PATH), { recursive: true });
    writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    renameSync(tmp, PAUSED_SESSIONS_PATH);
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

/**
 * Whether this session's observation recording is paused.
 *
 * Called from hooks on every tool use, so it must never throw and must not
 * write: a read that fails means "not paused". Silently pausing a session the
 * user never paused would lose their history with no signal.
 */
export function isSessionPaused(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const pausedAt = read()[sessionId];
  if (typeof pausedAt !== 'number') return false;
  return Date.now() - pausedAt < TTL_MS;
}

export function pauseSession(sessionId: string): void {
  if (!sessionId) return;
  const now = Date.now();
  const map = withoutExpired(read(), now);
  map[sessionId] = now;
  write(map);
}

export function resumeSession(sessionId: string): void {
  if (!sessionId) return;
  const map = withoutExpired(read(), Date.now());
  delete map[sessionId];
  write(map);
}
```

만료 정리는 **쓰기 시점에만** 파일에 반영한다. `isSessionPaused`는 훅이 도구 사용마다 호출하므로, 여기서 파일을 쓰면 매 이벤트가 디스크 쓰기가 된다. 읽을 때는 만료 항목을 `false`로 취급하기만 하고 파일은 건드리지 않는다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `bun test tests/shared/session-pause.test.ts`
Expected: PASS — 11 pass

- [ ] **Step 6: 타입 검사**

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 7: 커밋**

```bash
git add src/shared/session-pause.ts src/shared/paths.ts tests/shared/session-pause.test.ts
git commit -m "feat: add per-session observation pause state"
```

---

### Task 2: 훅 두 곳에 중단 검사 적용

**Files:**
- Modify: `src/cli/handlers/observation.ts` (`:59`의 `shouldTrackProject` 검사 다음)
- Modify: `src/cli/handlers/summarize.ts` (`:19`의 `shouldTrackProject` 검사 다음)
- Test: 기존 파일 3개에 케이스 추가 — `tests/cli/handlers/observation-client.test.ts`, `summarize-subagent-skip.test.ts`, `session-lifecycle-client.test.ts`

**Interfaces:**
- Consumes: `isSessionPaused(sessionId)`, `resumeSession(sessionId)` (Task 1)
- Produces: 없음

- [ ] **Step 1: 실패하는 테스트 작성**

**새 파일을 만들지 않는다.** `tests/cli/handlers/observation-client.test.ts`에 케이스를 추가한다. 이 파일은 client 런타임 mock 셋업(약 140줄)을 이미 갖추고 있고, 전송을 `recordToolUseCalls` 배열로 캡처하며, `afterAll`에서 모든 `mock.module`을 원복한다. 그 셋업을 새 파일에 복제하면 drift가 생기고, 복원을 빠뜨리면 무관한 테스트 수십 개가 깨진다(이 저장소에서 실제로 62개가 깨진 적이 있다).

파일 상단의 mock 블록 옆에 `session-pause`를 실제 모듈 그대로 두되, 임시 데이터 디렉터리를 쓰도록 `CLAUDE_MEM_DATA_DIR`을 설정한다. `describe` 블록 안, 기존 `it(...)` 아래에 추가한다:

```typescript
  it('일시 중지된 세션에서는 아무것도 전송하지 않는다', async () => {
    const { pauseSession, resumeSession } = await import('../../../src/shared/session-pause.js');
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');

    const before = recordToolUseCalls.length;
    pauseSession('session-client-1');
    try {
      const result = await observationHandler.execute(clientInput());
      expect(result.continue).toBe(true);
      // The point of the test: nothing was sent, not merely that it did not throw.
      expect(recordToolUseCalls.length).toBe(before);
    } finally {
      resumeSession('session-client-1');
    }
  });

  it('중단되지 않은 세션은 평소대로 전송한다', async () => {
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');

    const before = recordToolUseCalls.length;
    await observationHandler.execute(clientInput());
    expect(recordToolUseCalls.length).toBe(before + 1);
  });
```

두 번째 케이스가 대조군이다. 첫 번째만 있으면 핸들러가 어떤 이유로든 전송을 안 하게 되어도 통과한다.

`summarize`의 정리 순서는 `tests/cli/handlers/summarize-subagent-skip.test.ts`에 추가한다. 그 파일의 mock 셋업과 입력 헬퍼를 확인해 형태를 맞추되, 단언은 이것이다:

```typescript
  it('중단된 세션의 Stop은 요약을 건너뛰고 중단 항목을 지운다', async () => {
    const { pauseSession, isSessionPaused } = await import('../../../src/shared/session-pause.js');
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    pauseSession('session-summarize-1');
    expect(isSessionPaused('session-summarize-1')).toBe(true);

    // Use whatever input helper this file already defines; the session id must
    // match the one paused above.
    await summarizeHandler.execute({ sessionId: 'session-summarize-1', cwd: '/tmp/test-repo' } as any);

    // Cleared by the handler. Fails if the early return runs before the cleanup.
    expect(isSessionPaused('session-summarize-1')).toBe(false);
  });
```

`session-init`이 영향받지 않는다는 회귀는 `tests/cli/handlers/session-lifecycle-client.test.ts`에 추가한다. 그 파일에는 순서 의존 flake가 하나 있으니(기존 문제) 추가한 케이스가 단독 실행에서 통과하는지 따로 확인한다.

```typescript
  it('중단된 세션에서도 session-init은 평소대로 동작한다', async () => {
    const { pauseSession, resumeSession } = await import('../../../src/shared/session-pause.js');
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    pauseSession('session-client-1');
    try {
      // Same assertions the file's existing happy-path test makes — session-init
      // must behave identically whether or not recording is paused. This
      // asymmetry is the whole point of the feature.
      const result = await sessionInitHandler.execute(/* the file's input helper */);
      expect(result.continue).toBe(true);
    } finally {
      resumeSession('session-client-1');
    }
  });
```

세 파일 모두 실제 세션 상태 파일을 건드리므로, 각 케이스는 `finally`에서 반드시 원복한다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `bun test tests/cli/handlers/observation-client.test.ts tests/cli/handlers/summarize-subagent-skip.test.ts`
Expected: FAIL — 중단 검사가 아직 없으므로 관측이 전송되고 요약 항목도 지워지지 않는다. `session-lifecycle-client.test.ts`에 추가한 케이스는 이미 통과한다(그 경로는 바뀌지 않으므로 정상이다).

- [ ] **Step 3: `observation.ts`에 검사 추가**

import를 추가한다:

```typescript
import { isSessionPaused } from '../../shared/session-pause.js';
```

`shouldTrackProject` 검사(`:59`) 블록 **바로 다음**에 추가한다:

```typescript
    if (isSessionPaused(sessionId)) {
      logger.debug('HOOK', 'Session paused, skipping observation', { sessionId, toolName });
      return { continue: true, suppressOutput: true };
    }
```

- [ ] **Step 4: `summarize.ts`에 검사 추가**

import를 추가한다:

```typescript
import { isSessionPaused, resumeSession } from '../../shared/session-pause.js';
```

`shouldTrackProject` 검사(`:19`) 블록 **바로 다음**에 추가한다:

```typescript
    if (isSessionPaused(input.sessionId)) {
      // Stop fires at session end, so this is where the pause entry gets cleared.
      // Clear first, then skip — reversing the order leaves the entry behind
      // forever, because the early return would run before the cleanup.
      resumeSession(input.sessionId);
      logger.debug('HOOK', 'Session paused, skipping summary', { sessionId: input.sessionId });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }
```

`HOOK_EXIT_CODES`는 이 파일에 이미 import되어 있다(`summarize.ts:10`). `logger`도 이미 있다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `bun test tests/cli/handlers/observation-client.test.ts tests/cli/handlers/summarize-subagent-skip.test.ts tests/cli/handlers/session-lifecycle-client.test.ts`
Expected: PASS — 추가한 4개 케이스 포함 전부 통과

- [ ] **Step 6: 정리 순서가 실제로 검증되는지 확인**

`summarize.ts`에서 `resumeSession(...)` 호출을 `return` 문 **뒤로** 잠시 옮겨 두 번째 테스트가 실패하는지 확인한 뒤 되돌린다. 실패하지 않는다면 그 테스트는 순서를 검증하지 못하는 것이므로 단언을 고친다.

- [ ] **Step 7: 회귀 확인**

Run: `bun test tests/cli/ tests/shared/`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 8: 커밋**

```bash
git add src/cli/handlers/observation.ts src/cli/handlers/summarize.ts tests/cli/handlers/
git commit -m "feat: skip observation and summary for paused sessions"
```

---

### Task 3: `session` CLI 서브커맨드

**Files:**
- Create: `src/npx-cli/commands/session.ts`
- Modify: `src/npx-cli/index.ts`
- Test: `tests/npx-cli/session-command.test.ts`

**Interfaces:**
- Consumes: `pauseSession`, `resumeSession`, `isSessionPaused` (Task 1)
- Produces: `runSessionCommand(args: string[]): void` — `npx @bjlee2024/claude-mem session pause|resume|status <sessionId>`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/npx-cli/session-command.test.ts`. `tests/npx-cli/`의 기존 테스트를 먼저 읽어 출력 캡처 방식을 확인한다.

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dir: string;
const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sc-'));
  process.env.CLAUDE_MEM_DATA_DIR = dir;
});
afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

async function load() {
  return await import('../../src/npx-cli/commands/session.js?t=' + Math.random());
}

describe('session 커맨드', () => {
  it('pause 하면 그 세션이 중단 상태가 된다', async () => {
    const { runSessionCommand } = await load();
    const { isSessionPaused } = await import('../../src/shared/session-pause.js?t=' + Math.random());
    runSessionCommand(['pause', 'abc']);
    expect(isSessionPaused('abc')).toBe(true);
  });

  it('resume 하면 풀린다', async () => {
    const { runSessionCommand } = await load();
    const { isSessionPaused } = await import('../../src/shared/session-pause.js?t=' + Math.random());
    runSessionCommand(['pause', 'abc']);
    runSessionCommand(['resume', 'abc']);
    expect(isSessionPaused('abc')).toBe(false);
  });

  it('세션 ID가 없으면 상태를 바꾸지 않는다', async () => {
    const { runSessionCommand } = await load();
    const { isSessionPaused } = await import('../../src/shared/session-pause.js?t=' + Math.random());
    runSessionCommand(['pause']);
    expect(isSessionPaused('')).toBe(false);
  });

  it('알 수 없는 하위 명령은 상태를 바꾸지 않는다', async () => {
    const { runSessionCommand } = await load();
    const { isSessionPaused } = await import('../../src/shared/session-pause.js?t=' + Math.random());
    runSessionCommand(['bogus', 'abc']);
    expect(isSessionPaused('abc')).toBe(false);
  });
});
```

`runSessionCommand`가 인자 오류에서 `process.exit`를 호출한다면 테스트가 프로세스를 죽인다. 그런 경우 종료 코드를 반환하는 형태로 설계하거나, 기존 npx-cli 명령이 오류를 어떻게 다루는지 확인해 같은 방식을 따르되 테스트 가능하게 만든다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `bun test tests/npx-cli/session-command.test.ts`
Expected: FAIL — `Cannot find module '../../src/npx-cli/commands/session.js'`

- [ ] **Step 3: 커맨드 구현**

`src/npx-cli/commands/session.ts`:

```typescript
import pc from 'picocolors';
import { pauseSession, resumeSession, isSessionPaused } from '../../shared/session-pause.js';

const USAGE = 'Usage: npx @bjlee2024/claude-mem session <pause|resume|status> <sessionId>';

/**
 * Manages per-session observation recording. The session id is passed in rather
 * than read from the environment: this process is not the session it acts on,
 * and the caller (the pause/resume skill) is the one that knows its own id.
 */
export function runSessionCommand(args: string[]): void {
  const [sub, sessionId] = args;

  if (!sub || !['pause', 'resume', 'status'].includes(sub)) {
    console.error(pc.red(`Unknown session command: ${sub ?? '(none)'}`));
    console.error(USAGE);
    return;
  }

  if (!sessionId || !sessionId.trim()) {
    console.error(pc.red('A session id is required.'));
    console.error(USAGE);
    return;
  }

  const id = sessionId.trim();

  if (sub === 'pause') {
    pauseSession(id);
    console.log(`Observation recording paused for this session (${id}).`);
    console.log('Context injection continues. Already-recorded observations are unaffected.');
    return;
  }

  if (sub === 'resume') {
    resumeSession(id);
    console.log(`Observation recording resumed for this session (${id}).`);
    return;
  }

  console.log(isSessionPaused(id) ? `paused (${id})` : `recording (${id})`);
}
```

`picocolors`는 이 저장소가 이미 쓰는 의존성이다(`src/npx-cli/commands/server.ts`에서 `pc`로 import). 새 의존성이 아니다.

- [ ] **Step 4: CLI 분기에 등록**

`src/npx-cli/index.ts`의 `switch (command)` 안, `case 'start':` 근처에 추가한다.

```typescript
    case 'session': {
      const { runSessionCommand } = await import('./commands/session.js');
      runSessionCommand(args);
      break;
    }
```

`args`가 서브커맨드 이후의 인자 배열인지 확인한다 — 다른 `case`가 `args`를 어떻게 쓰는지 보고 맞춘다. `session pause <id>`에서 `runSessionCommand`가 `['pause', '<id>']`를 받아야 한다.

- [ ] **Step 5: 도움말에 추가**

`src/npx-cli/index.ts`의 도움말 문자열(`npx @bjlee2024/claude-mem client status` 줄이 있는 블록)에 추가한다.

```
  ${pc.cyan('npx @bjlee2024/claude-mem session pause|resume|status <id>')}   Pause or resume observation recording for one session
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `bun test tests/npx-cli/session-command.test.ts`
Expected: PASS — 4 pass

- [ ] **Step 7: 실제 CLI로 확인**

```bash
npx tsx src/npx-cli/index.ts session status test-id-123
npx tsx src/npx-cli/index.ts session pause test-id-123
npx tsx src/npx-cli/index.ts session status test-id-123
npx tsx src/npx-cli/index.ts session resume test-id-123
npx tsx src/npx-cli/index.ts session status test-id-123
```

Expected: `recording` → (pause 메시지) → `paused` → (resume 메시지) → `recording`

이 명령이 실제 `~/.claude-mem/paused-sessions.json`을 건드리므로, 확인 후 `test-id-123` 항목이 남지 않았는지 본다.

- [ ] **Step 8: 커밋**

```bash
git add src/npx-cli/commands/session.ts src/npx-cli/index.ts tests/npx-cli/session-command.test.ts
git commit -m "feat(cli): add session pause|resume|status subcommand"
```

---

### Task 4: pause / resume 스킬

**Files:**
- Create: `plugin/skills/pause/SKILL.md`
- Create: `plugin/skills/resume/SKILL.md`

**Interfaces:**
- Consumes: `npx @bjlee2024/claude-mem session pause|resume|status <sessionId>` (Task 3)
- Produces: 없음 (최종 사용자 인터페이스)

- [ ] **Step 1: 기존 스킬 형식 확인**

Run: `head -20 plugin/skills/filter/SKILL.md`
Expected: `---` frontmatter에 `name`과 `description`. `description`은 이 스킬이 언제 떠야 하는지를 구체적으로 적는 필드다 — 요약이 아니라 트리거로 쓴다.

- [ ] **Step 2: `pause` 스킬 작성**

`plugin/skills/pause/SKILL.md`:

```markdown
---
name: pause
description: Stop recording observations for the current session while keeping past memory available. Use when the user says "don't record this", "pause memory", "stop tracking this session", or is about to do something they don't want in their history.
---

# Pause Observation Recording

Stops claude-mem from recording what happens in this session. Past memory keeps
being injected — only the writing stops.

## How to run it

**Step 1 — get the session id.**

```bash
echo "$CLAUDE_CODE_SESSION_ID"
```

If it prints nothing, stop. Tell the user you cannot identify the current
session, so you will not change anything. Do not guess an id.

**Step 2 — pause.**

```bash
npx @bjlee2024/claude-mem session pause "$CLAUDE_CODE_SESSION_ID"
```

**Step 3 — tell the user what changed.**

Say all four:

- Tool-use observations and the end-of-session summary will not be recorded.
- Context injection continues — past memory still reaches you.
- Observations already recorded in this session stay; this does not erase them.
- It lifts automatically when the session ends. Use `/claude-mem:resume` to turn
  recording back on sooner.

The last point matters: without it the user is left wondering whether their next
session is still paused.
```

- [ ] **Step 3: `resume` 스킬 작성**

`plugin/skills/resume/SKILL.md`:

```markdown
---
name: resume
description: Resume recording observations for the current session after it was paused. Use when the user says "start recording again", "resume memory", or "unpause".
---

# Resume Observation Recording

Turns recording back on for this session after `/claude-mem:pause`.

## How to run it

**Step 1 — get the session id.**

```bash
echo "$CLAUDE_CODE_SESSION_ID"
```

If it prints nothing, stop and tell the user you cannot identify the current
session. Do not guess an id.

**Step 2 — resume.**

```bash
npx @bjlee2024/claude-mem session resume "$CLAUDE_CODE_SESSION_ID"
```

**Step 3 — tell the user what changed.**

Recording is back on from this point. Anything that happened while paused was
not recorded and cannot be recovered — say so plainly rather than implying it
will be backfilled.

If the user was not paused to begin with, the command is harmless; say that
recording was already on rather than implying something changed.
```

- [ ] **Step 4: 빌드로 스킬이 동기화되는지 확인**

Run: `npm run build-and-sync && ls ~/.claude/plugins/marketplaces/bjlee2024/plugin/skills/ | grep -E "pause|resume"`
Expected: `pause`와 `resume` 두 줄

- [ ] **Step 5: 커밋**

```bash
git add plugin/skills/pause/SKILL.md plugin/skills/resume/SKILL.md plugin/ dist/
git commit -m "feat(skill): add /claude-mem:pause and /claude-mem:resume"
```

---

### Task 5: 통합 검증

**Files:** 없음 (검증 전용)

**Interfaces:**
- Consumes: Task 1~4 전부

- [ ] **Step 1: 전체 검증**

Run: `npm run typecheck`
Expected: root와 viewer 양쪽 통과

Run: `bun test`
Expected: 기존 대비 실패 증가 없음. `tests/cli/handlers/session-lifecycle-client.test.ts` 1건은 이 작업 이전부터 있던 순서 의존 flake다.

- [ ] **Step 2: 상태 파일이 깨끗한지 확인**

Run: `cat ~/.claude-mem/paused-sessions.json 2>/dev/null || echo "(없음 — 정상)"`
Expected: 파일이 없거나 `{}`. Task 3 Step 7의 `test-id-123`이 남아 있으면 지운다.

- [ ] **Step 3: 훅 경로 실측**

`isSessionPaused`가 훅에서 실제로 불리는지 확인한다. 임의의 세션 ID를 중단시킨 뒤 상태를 조회한다.

```bash
npx tsx src/npx-cli/index.ts session pause verify-123
npx tsx src/npx-cli/index.ts session status verify-123
npx tsx src/npx-cli/index.ts session resume verify-123
```

Expected: `paused (verify-123)` → resume 후 상태가 `recording`

- [ ] **Step 4: 사용자에게 실제 확인 요청**

새 세션에서 다음을 확인해 달라고 요청한다. 슬래시 커맨드는 플러그인 동기화 후 새 세션에서만 나타난다.

1. `/claude-mem:pause` 실행
2. 도구를 몇 번 쓰는 작업 수행
3. `/claude-mem:resume` 실행
4. 중단 구간의 관측이 기록되지 않았는지 확인

server-beta 런타임이면 다음 쿼리로 확인할 수 있다. 중단 구간에 해당하는 시각의 관측이 없어야 한다.

```bash
docker exec claude-mem-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT to_char(created_at, '"'"'HH24:MI:SS'"'"') AS t, left(metadata->>'"'"'title'"'"', 50) AS title
FROM observations ORDER BY created_at DESC LIMIT 10;"'
```

- [ ] **Step 5: 설정 문서화**

`docs/public/`에서 claude-mem의 훅/설정을 설명하는 문서를 찾아(`grep -rl "CLAUDE_MEM_EXCLUDED_PROJECTS" docs/`) 세션 일시 중지를 추가한다. **한국어로 쓴다**(프로젝트 규칙). 다음을 포함한다.

- `/claude-mem:pause`와 `/claude-mem:resume`의 동작
- 중단되는 것(도구 기록, 세션 요약)과 계속되는 것(컨텍스트 주입)
- 세션 종료 시 자동 해제되며, 24시간이 지나면 만료된다는 것
- 이미 기록된 관측은 지워지지 않는다는 것
- `CLAUDE_MEM_EXCLUDED_PROJECTS`와의 차이 — 그쪽은 컨텍스트 주입까지 막는다

- [ ] **Step 6: 커밋**

```bash
git add docs/
git commit -m "docs: 세션 단위 관측 기록 일시 중지 문서화"
```

---

## 구현자를 위한 주의사항

1. **`isSessionPaused`는 절대 던지지 않는다.** 훅은 사용자의 모든 도구 사용 경로에 있다. 상태 파일 하나 때문에 작업이 막히면 안 된다.
2. **읽기는 파일을 쓰지 않는다.** 만료 정리를 `isSessionPaused`에 넣으면 도구 사용마다 디스크 쓰기가 발생한다.
3. **`summarize`의 순서.** 정리가 먼저, 조기 반환이 나중. Task 2 Step 6이 이를 검증한다.
4. **`session-init`은 건드리지 않는다.** 컨텍스트 주입이 유지되는 것이 이 기능의 존재 이유다.
5. **mock 복원.** 훅 테스트에서 `mock.module`을 쓰면 `afterAll`에서 반드시 되돌린다. 이 저장소에서 복원 누락으로 무관한 테스트 62개가 깨진 적이 있다.
