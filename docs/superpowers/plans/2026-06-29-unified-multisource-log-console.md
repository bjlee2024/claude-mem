# 멀티소스 통합 로그 console — 구현 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** server-beta web console(`LogsDrawer`)이 server·worker·client 세 소스의 로그를 component/source별로 한 화면에 보여주게 한다.

**Architecture:** 통합 지점은 server의 `Logger` 인스턴스. server 로그는 직접 적재, worker 로그는 공유 volume 파일 tail로 pull, client 로그는 `POST /v1/logs/ingest`로 push. `GET /api/logs`가 통합 결과를 텍스트로 반환하고 UI는 기존 폴링을 유지한다.

**Tech Stack:** TypeScript, Bun(`bun test`), Express, React(viewer), Postgres/Valkey(server-beta), Docker.

## Global Constraints

- 로그 라인 직렬화 포맷: `[<ts>] [<LEVEL>] [<COMPONENT>] [<SOURCE>] <correlation?> <message>` — `SOURCE ∈ {server, worker, client}`. 기존 라인(SOURCE 없음)도 파싱 호환.
- `LogLevel`: `DEBUG=0, INFO=1, WARN=2, ERROR=3, SILENT=4` (`src/utils/logger.ts:7`).
- client→server 전송 레벨 게이트 기본값: `CLAUDE_MEM_LOG_FORWARD_LEVEL=WARN`.
- ingest는 인증 필수(`requireServerAuth` writeAuth). 읽기(`/api/logs`)는 기존대로 무인증(신뢰 tailnet).
- best-effort 전송: client 로그 전송 실패는 무시, 정상 hook 흐름을 절대 차단하지 않는다.
- ring buffer 상한: `MAX_RECENT_LOGS` 2000 → 5000.
- 테스트는 `bun:test` (`import { describe, it, expect } from 'bun:test'`).

---

## File Structure

- `src/utils/logger.ts` (수정) — 구조화 store, `source`, `ingestExternalLogs()`, forward buffer + `drainForwardBuffer()`, 직렬화에 source 포함.
- `src/server/runtime/WorkerLogCollector.ts` (신규) — 공유 volume 로그 파일 offset tail → `logger.ingestExternalLogs(lines, 'worker')`.
- `src/server/routes/v1/ServerV1Routes.ts` (수정) — `POST /v1/logs/ingest` (writeAuth) → `ingestExternalLogs(lines, 'client')`.
- `src/server/runtime/create-server-beta-service.ts` (수정) — `WorkerLogCollector` 기동(HTTP server 모드에서만).
- `src/services/hooks/server-beta-client.ts` (수정) — `forwardLogs(lines)` 메서드(`POST /v1/logs/ingest`).
- client hook 종료 경로 (수정) — `logger.drainForwardBuffer()` → `client.forwardLogs()` best-effort.
- `src/ui/viewer/components/LogsModal.tsx` (수정) — `LogComponent` 동기화, `parseLogLine` source 그룹, source 배지/필터.
- `src/shared/SettingsDefaultsManager.ts` (수정) — `CLAUDE_MEM_LOG_FORWARD_LEVEL` 기본값.

---

## Task 1: Logger — 구조화 store + source 직렬화

**Files:**
- Modify: `src/utils/logger.ts` (`recentLogs`/`MAX_RECENT_LOGS`/`private log()`/`getRecentLogs()`)
- Test: `tests/utils/logger-store.test.ts`

**Interfaces:**
- Produces:
  - `logger.ingestExternalLogs(lines: string[], source: 'worker' | 'client'): void`
  - 직렬화 라인에 `[<SOURCE>]`가 component 뒤에 포함됨.

- [ ] **Step 1: 실패 테스트 작성** — `tests/utils/logger-store.test.ts`

```ts
import { describe, it, expect } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

describe('logger unified store', () => {
  it('tags the process own logs with [server] source', () => {
    logger.clearRecentLogs();
    logger.info('SYSTEM', 'hello world');
    const out = logger.getRecentLogs();
    expect(out).toContain('[SYSTEM]');
    expect(out).toContain('[server]');
    expect(out).toContain('hello world');
  });

  it('ingests external worker lines verbatim and returns them', () => {
    logger.clearRecentLogs();
    logger.ingestExternalLogs(
      ['[2026-06-29 00:00:00.000] [INFO ] [WORKER] generation done'],
      'worker',
    );
    const out = logger.getRecentLogs();
    expect(out).toContain('[WORKER]');
    expect(out).toContain('[worker]');
    expect(out).toContain('generation done');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `bun test tests/utils/logger-store.test.ts`
Expected: FAIL (`ingestExternalLogs is not a function`, `[server]` 미포함).

- [ ] **Step 3: 구현** — `src/utils/logger.ts`

`private log(...)`의 라인 조립부에서 component 뒤에 source를 삽입한다. 기존:
```ts
const logLine = `[${timestamp}] [${levelStr}] [${componentStr}] ${correlationStr}${message}${contextStr}${dataStr}`;
```
를 다음으로 교체:
```ts
const logLine = `[${timestamp}] [${levelStr}] [${componentStr}] [server ] ${correlationStr}${message}${contextStr}${dataStr}`;
```

`MAX_RECENT_LOGS`를 `5000`으로 변경. 클래스에 메서드 추가(직렬화는 그대로 문자열 ring 유지, source는 이미 라인에 포함되어 단순화):
```ts
/** Ingest pre-formatted log lines from another process (worker file tail or
 *  client push). Lines are stored verbatim into the same ring buffer that
 *  backs the viewer's /api/logs, tagged so the UI can show their origin. */
ingestExternalLogs(lines: string[], source: 'worker' | 'client'): void {
  const tag = `[${source.padEnd(6)}]`;
  for (const raw of lines) {
    if (!raw) continue;
    // Insert the source tag right after the [COMPONENT] field if the line
    // matches the standard format; otherwise store raw with a trailing tag.
    const tagged = /^\[[^\]]+\] \[[^\]]+\] \[[^\]]+\]/.test(raw) && !raw.includes(`] ${tag}`)
      ? raw.replace(/^(\[[^\]]+\] \[[^\]]+\] \[[^\]]+\]) /, `$1 ${tag} `)
      : `${raw} ${tag}`;
    this.recentLogs.push(tagged);
  }
  if (this.recentLogs.length > Logger.MAX_RECENT_LOGS) {
    this.recentLogs.splice(0, this.recentLogs.length - Logger.MAX_RECENT_LOGS);
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test tests/utils/logger-store.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/utils/logger.ts tests/utils/logger-store.test.ts
git commit -m "feat(logger): tag own logs with source + ingest external log lines"
```

---

## Task 2: Logger — client forward buffer + 레벨 게이트

**Files:**
- Modify: `src/utils/logger.ts`
- Test: `tests/utils/logger-forward.test.ts`

**Interfaces:**
- Consumes: `LogLevel` enum.
- Produces:
  - `logger.drainForwardBuffer(): string[]` — 누적된 forward 대상 라인을 반환하고 버퍼를 비운다.
  - 게이트: `process.env.CLAUDE_MEM_LOG_FORWARD_LEVEL`(기본 `WARN`) 이상 레벨만 버퍼에 누적.

- [ ] **Step 1: 실패 테스트 작성** — `tests/utils/logger-forward.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

describe('logger forward buffer', () => {
  beforeEach(() => { delete process.env.CLAUDE_MEM_LOG_FORWARD_LEVEL; logger.drainForwardBuffer(); });

  it('buffers WARN/ERROR by default and drains them once', () => {
    logger.info('HOOK', 'noise');     // below default WARN
    logger.warn('HOOK', 'careful');
    logger.error('DB', 'broke');
    const drained = logger.drainForwardBuffer();
    expect(drained.length).toBe(2);
    expect(drained.join('\n')).toContain('careful');
    expect(drained.join('\n')).toContain('broke');
    expect(logger.drainForwardBuffer().length).toBe(0); // emptied
  });

  it('honors CLAUDE_MEM_LOG_FORWARD_LEVEL=INFO', () => {
    process.env.CLAUDE_MEM_LOG_FORWARD_LEVEL = 'INFO';
    logger.drainForwardBuffer();
    logger.info('HOOK', 'now kept');
    expect(logger.drainForwardBuffer().some(l => l.includes('now kept'))).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `bun test tests/utils/logger-forward.test.ts`
Expected: FAIL (`drainForwardBuffer is not a function`).

- [ ] **Step 3: 구현** — `src/utils/logger.ts`

클래스 필드 + 메서드 추가, `private log()` 끝에 buffer push 훅 추가:
```ts
private forwardBuffer: string[] = [];
private static readonly MAX_FORWARD_BUFFER = 500;

private forwardLevelThreshold(): LogLevel {
  const raw = (process.env.CLAUDE_MEM_LOG_FORWARD_LEVEL ?? 'WARN').toUpperCase();
  const v = (LogLevel as unknown as Record<string, number>)[raw];
  return typeof v === 'number' ? (v as LogLevel) : LogLevel.WARN;
}

/** Pull and clear log lines queued for forwarding to the server. */
drainForwardBuffer(): string[] {
  const out = this.forwardBuffer;
  this.forwardBuffer = [];
  return out;
}
```
`private log()` 안에서 `this.recentLogs.push(logLine)` 직후에 추가:
```ts
if (level >= this.forwardLevelThreshold()) {
  this.forwardBuffer.push(logLine);
  if (this.forwardBuffer.length > Logger.MAX_FORWARD_BUFFER) {
    this.forwardBuffer.splice(0, this.forwardBuffer.length - Logger.MAX_FORWARD_BUFFER);
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test tests/utils/logger-forward.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/utils/logger.ts tests/utils/logger-forward.test.ts
git commit -m "feat(logger): level-gated forward buffer for client log push"
```

---

## Task 3: WorkerLogCollector — 공유 volume 파일 tail

**Files:**
- Create: `src/server/runtime/WorkerLogCollector.ts`
- Test: `tests/server/worker-log-collector.test.ts`

**Interfaces:**
- Consumes: `logger.ingestExternalLogs(lines, 'worker')`.
- Produces:
  - `class WorkerLogCollector { constructor(opts: { logDir: string; intervalMs?: number }); pollOnce(): void; start(): void; stop(): void; }`
  - `pollOnce()`는 logDir의 최신 `*.log` 새 바이트만 읽어 줄 단위로 `ingestExternalLogs`에 전달(파일별 offset 유지).

- [ ] **Step 1: 실패 테스트 작성** — `tests/server/worker-log-collector.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../src/utils/logger.js';
import { WorkerLogCollector } from '../../src/server/runtime/WorkerLogCollector.js';

describe('WorkerLogCollector', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wlc-')); logger.clearRecentLogs(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('ingests only newly appended lines as source=worker', () => {
    const f = join(dir, 'claude-mem-2026-06-29.log');
    writeFileSync(f, '[2026-06-29 00:00:00.000] [INFO ] [SYSTEM] boot\n');
    const c = new WorkerLogCollector({ logDir: dir });
    c.pollOnce(); // consumes the existing line
    appendFileSync(f, '[2026-06-29 00:00:01.000] [WARN ] [DB] slow query\n');
    c.pollOnce(); // should pick up only the new line
    const out = logger.getRecentLogs();
    expect(out).toContain('slow query');
    expect(out).toContain('[worker]');
    // second poll with no new bytes adds nothing
    const before = logger.getRecentLogs().length;
    c.pollOnce();
    expect(logger.getRecentLogs().length).toBe(before);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `bun test tests/server/worker-log-collector.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: 구현** — `src/server/runtime/WorkerLogCollector.ts`

```ts
// SPDX-License-Identifier: Apache-2.0
import { readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';

export class WorkerLogCollector {
  private readonly logDir: string;
  private readonly intervalMs: number;
  private offsets = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { logDir: string; intervalMs?: number }) {
    this.logDir = opts.logDir;
    this.intervalMs = opts.intervalMs ?? 3000;
  }

  pollOnce(): void {
    let files: string[];
    try { files = readdirSync(this.logDir).filter(f => f.endsWith('.log')); }
    catch { return; }
    for (const name of files) {
      const path = join(this.logDir, name);
      let size: number;
      try { size = statSync(path).size; } catch { continue; }
      const prev = this.offsets.get(path) ?? size; // first sight: skip backlog, start at EOF
      if (size <= prev) { this.offsets.set(path, size); continue; }
      const len = size - prev;
      const buf = Buffer.alloc(len);
      try {
        const fd = openSync(path, 'r');
        try { readSync(fd, buf, 0, len, prev); } finally { closeSync(fd); }
      } catch { continue; }
      this.offsets.set(path, size);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      if (lines.length) logger.ingestExternalLogs(lines, 'worker');
    }
  }

  start(): void {
    if (this.timer) return;
    this.pollOnce();
    this.timer = setInterval(() => this.pollOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
```

주의: 테스트는 "기존 라인 skip"을 기대한다 — 첫 `pollOnce()`가 기존 파일을 EOF로 간주(`prev = size`)하도록 구현됨. 단, 테스트는 첫 poll 전에 파일이 이미 존재하므로 첫 poll에서 offset을 size로 세팅 → 이후 append만 수집. (테스트의 첫 줄 'boot'은 수집 안 됨이 정상이며, 'slow query'만 검증한다.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test tests/server/worker-log-collector.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/server/runtime/WorkerLogCollector.ts tests/server/worker-log-collector.test.ts
git commit -m "feat(server): WorkerLogCollector tails shared-volume worker logs"
```

---

## Task 4: server — `/v1/logs/ingest` endpoint + collector 기동

**Files:**
- Modify: `src/server/routes/v1/ServerV1Routes.ts` (writeAuth 패턴은 `:150` `/v1/events` 참고)
- Modify: `src/server/runtime/create-server-beta-service.ts` (HTTP server 모드 시작부)
- Test: `tests/server/logs-ingest.test.ts`

**Interfaces:**
- Consumes: `requireServerAuth`(`writeAuth`), `logger.ingestExternalLogs(lines, 'client')`, `WorkerLogCollector`.
- Produces: `POST /v1/logs/ingest` body `{ lines: string[] }` → 204. 인증 없으면 401/403.

- [ ] **Step 1: 실패 테스트 작성** — `tests/server/logs-ingest.test.ts`

기존 `tests/server/*.test.ts`의 express app + 인증 셋업 패턴(예: `auth-api-key.test.ts`, `mcp-surface.test.ts`)을 따라 in-memory SQLite + 유효 API key로 앱을 구성하고:
```ts
import { describe, it, expect } from 'bun:test';
// (auth/app 부트스트랩은 mcp-surface.test.ts 패턴 재사용)
// 1) 인증된 POST /v1/logs/ingest { lines: ['[..] [WARN ] [HOOK] hi'] } → 200/204
// 2) 인증 헤더 없는 동일 요청 → 401 또는 403
// 3) 성공 후 GET /api/logs 응답에 'hi' 와 '[client]' 포함
```
(실제 부트스트랩 코드는 `mcp-surface.test.ts`의 `buildTestApp` 류 헬퍼를 import해 재사용한다. 새 헬퍼를 만들지 말 것.)

- [ ] **Step 2: 테스트 실패 확인**

Run: `bun test tests/server/logs-ingest.test.ts`
Expected: FAIL (404 on `/v1/logs/ingest`).

- [ ] **Step 3: 구현**

`ServerV1Routes.ts`의 라우트 등록부(다른 `app.post('/v1/...', writeAuth, ...)` 옆)에 추가:
```ts
import { z } from 'zod';
import { logger } from '../../../utils/logger.js';
// ...
const IngestLogsSchema = z.object({ lines: z.array(z.string()).min(1).max(500) });
app.post('/v1/logs/ingest', writeAuth, (req, res) => {
  const parsed = IngestLogsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid body' }); return; }
  logger.ingestExternalLogs(parsed.data.lines, 'client');
  res.status(204).end();
});
```

`create-server-beta-service.ts`에서 HTTP 서버(viewer/route) 구성 직후, generation worker가 아닌 **HTTP 모드일 때만** collector를 기동:
```ts
import { WorkerLogCollector } from './WorkerLogCollector.js';
import { join } from 'path';
// ... HTTP server 경로에서:
const logDir = join(process.env.CLAUDE_MEM_DATA_DIR ?? '/data/claude-mem', 'logs');
const workerLogCollector = new WorkerLogCollector({ logDir });
workerLogCollector.start();
// service.stop() 경로에서 workerLogCollector.stop() 호출 연결.
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test tests/server/logs-ingest.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/server/routes/v1/ServerV1Routes.ts src/server/runtime/create-server-beta-service.ts tests/server/logs-ingest.test.ts
git commit -m "feat(server): /v1/logs/ingest + start WorkerLogCollector in HTTP mode"
```

---

## Task 5: client — 로그 전송기 + hook 종료 flush

**Files:**
- Modify: `src/services/hooks/server-beta-client.ts` (`:234` 클래스에 메서드 추가)
- Modify: client hook 종료 경로 — 우선 `src/services/hooks/runtime-selector.ts`의 client 컨텍스트 사용처(예: 각 핸들러가 끝나는 공통 지점) 또는 `executeWithWorkerFallback` 대체 경로. 구현 시 `buildClientContext` 사용처를 찾아 hook 응답 직전에 flush 호출을 건다.
- Test: `tests/hooks/forward-logs.test.ts`

**Interfaces:**
- Consumes: `logger.drainForwardBuffer()`.
- Produces: `client.forwardLogs(lines: string[]): Promise<void>` — `POST /v1/logs/ingest`. 실패는 throw하지 않고 무시(best-effort).

- [ ] **Step 1: 실패 테스트 작성** — `tests/hooks/forward-logs.test.ts`

```ts
import { describe, it, expect } from 'bun:test';
import { ServerBetaClient } from '../../src/services/hooks/server-beta-client.js';

describe('ServerBetaClient.forwardLogs', () => {
  it('POSTs lines to /v1/logs/ingest and swallows network errors', async () => {
    const calls: { url: string; body: any }[] = [];
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 204, text: async () => '' } as any;
    };
    const client = new ServerBetaClient({ serverBaseUrl: 'http://x:1', apiKey: 'k', fetchImpl: fakeFetch as any });
    await client.forwardLogs(['[..] [WARN ] [HOOK] hi']);
    expect(calls[0].url).toContain('/v1/logs/ingest');
    expect(calls[0].body.lines[0]).toContain('hi');

    const boom = new ServerBetaClient({ serverBaseUrl: 'http://x:1', apiKey: 'k', fetchImpl: (async () => { throw new Error('down'); }) as any });
    await boom.forwardLogs(['x']); // must NOT throw
    expect(true).toBe(true);
  });
});
```
(주의: `ServerBetaClient` 생성자가 `fetchImpl` 주입을 지원하는지 확인. 미지원이면 이 테스트의 주입 방식을 기존 생성자 시그니처에 맞춰 조정하되, 의존성 주입이 없으면 `fetchImpl?` optional 파라미터를 생성자에 추가하는 최소 변경을 같은 task에서 수행한다.)

- [ ] **Step 2: 테스트 실패 확인**

Run: `bun test tests/hooks/forward-logs.test.ts`
Expected: FAIL (`forwardLogs is not a function`).

- [ ] **Step 3: 구현** — `server-beta-client.ts`

클래스에 메서드 추가(기존 `recordEvent` 등이 사용하는 내부 요청 헬퍼를 재사용; 헬퍼 이름은 파일에서 확인). best-effort:
```ts
/** Best-effort: push buffered client log lines to the server. Never throws. */
async forwardLogs(lines: string[]): Promise<void> {
  if (!lines.length) return;
  try {
    await this.request('POST', '/v1/logs/ingest', { lines: lines.slice(0, 500) });
  } catch {
    // best-effort: dropping logs must never break the hook
  }
}
```
(`this.request(...)`가 실제 내부 헬퍼명이 아니라면, `recordEvent`가 호출하는 동일 헬퍼로 맞춘다. 인증 헤더는 그 헬퍼가 이미 부착.)

hook 종료 공통 지점(`buildClientContext` 사용처에서 hook 응답 반환 직전)에 best-effort flush:
```ts
import { logger } from '../../utils/logger.js';
// ...hook 처리 후, 응답 직전:
const pending = logger.drainForwardBuffer();
if (pending.length) { void ctx.client.forwardLogs(pending); } // fire-and-forget
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test tests/hooks/forward-logs.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/services/hooks/server-beta-client.ts src/services/hooks/runtime-selector.ts tests/hooks/forward-logs.test.ts
git commit -m "feat(client): best-effort forward of buffered logs to /v1/logs/ingest"
```

---

## Task 6: UI — LogsModal component 동기화 + source 배지/필터

**Files:**
- Modify: `src/ui/viewer/components/LogsModal.tsx`
- Test: `tests/ui/parse-log-line.test.ts` (parseLogLine을 export하여 단위 테스트)

**Interfaces:**
- Consumes: `/api/logs` 텍스트(라인에 `[<SOURCE>]` 포함 가능).
- Produces: `parseLogLine(line)`이 `source?: 'server'|'worker'|'client'`를 채움. `LogComponent`가 logger `Component` 상위집합 포함.

- [ ] **Step 1: 실패 테스트 작성** — `tests/ui/parse-log-line.test.ts`

```ts
import { describe, it, expect } from 'bun:test';
import { parseLogLine } from '../../src/ui/viewer/components/LogsModal.js';

describe('parseLogLine with source', () => {
  it('extracts source when present', () => {
    const p = parseLogLine('[2026-06-29 00:00:00.000] [WARN ] [DB    ] [worker] slow');
    expect(p.component).toBe('DB');
    expect(p.source).toBe('worker');
    expect(p.message).toBe('slow');
  });
  it('still parses legacy lines without source', () => {
    const p = parseLogLine('[2026-06-29 00:00:00.000] [INFO ] [SYSTEM] boot');
    expect(p.component).toBe('SYSTEM');
    expect(p.source).toBeUndefined();
    expect(p.message).toBe('boot');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `bun test tests/ui/parse-log-line.test.ts`
Expected: FAIL (`parseLogLine` 미export 또는 source 미지원).

- [ ] **Step 3: 구현** — `LogsModal.tsx`

`parseLogLine`을 `export function parseLogLine` 으로 export. 정규식에 optional source 그룹 추가:
```ts
const KNOWN_SOURCES = new Set(['server', 'worker', 'client']);
export function parseLogLine(line: string): ParsedLogLine {
  const pattern = /^\[([^\]]+)\]\s+\[(\w+)\s*\]\s+\[(\w+)\s*\]\s+(?:\[([a-z]+)\s*\]\s+)?(?:\[([^\]]+)\]\s+)?(.*)$/;
  const match = line.match(pattern);
  if (!match) return { raw: line };
  const [, timestamp, level, component, maybeSource, correlationId, message] = match;
  const source = maybeSource && KNOWN_SOURCES.has(maybeSource) ? (maybeSource as ParsedLogLine['source']) : undefined;
  // ...isSpecial 판정은 기존 로직 유지...
  return { raw: line, timestamp, level: level?.trim() as LogLevel, component: component?.trim() as LogComponent, source, correlationId: correlationId || undefined, message, isSpecial };
}
```
`ParsedLogLine`에 `source?: 'server' | 'worker' | 'client';` 추가.
`LogComponent` 유니온에 logger의 `Component`에서 빠진 항목 보강(최소: `'SECURITY' | 'QUEUE' | 'GIT' | 'ENV' | 'CONFIG' | 'SESSION' | 'CONSOLE'` 등). `LOG_COMPONENTS` 배열과 `activeComponents`/`setAllComponents` 기본 Set도 동일 목록으로 갱신.
필터에 source 토글 추가: `activeSources` Set state(기본 3개 모두) + 칩 UI(레벨/컴포넌트 칩과 동일 패턴) + `filteredLines`에 `(!line.source || activeSources.has(line.source))` 조건 추가. 각 줄 렌더에 source 배지 span 추가.

- [ ] **Step 4: 테스트 통과 + 빌드 확인**

Run: `bun test tests/ui/parse-log-line.test.ts` → PASS
Run: `npx tsc --noEmit -p src/ui/viewer/tsconfig.json` → no error

- [ ] **Step 5: 커밋**

```bash
git add src/ui/viewer/components/LogsModal.tsx tests/ui/parse-log-line.test.ts
git commit -m "feat(viewer): source badge/filter + sync component list in console"
```

---

## Task 7: 설정 기본값 + 통합 검증 + 빌드/배포

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts` (기본값 맵에 추가)
- Modify: `docker-compose.my.yml` (worker/server `environment`에 전달 — 선택)

- [ ] **Step 1: 설정 기본값 추가** — `SettingsDefaultsManager.ts`의 defaults 맵에 한 줄:
```ts
CLAUDE_MEM_LOG_FORWARD_LEVEL: 'WARN',
```

- [ ] **Step 2: 전체 타입체크 + 테스트**

Run: `npx tsc --noEmit`
Run: `bun test tests/utils/logger-store.test.ts tests/utils/logger-forward.test.ts tests/server/worker-log-collector.test.ts tests/server/logs-ingest.test.ts tests/hooks/forward-logs.test.ts tests/ui/parse-log-line.test.ts`
Expected: 모두 PASS, 타입 에러 0.

- [ ] **Step 3: 빌드**

Run: `npm run build`
Expected: exit 0 (esbuild 번들 + viewer-bundle.js 갱신).

- [ ] **Step 4: 통합 동작 검증 (수동)**

```bash
# server/worker 이미지 재빌드 + 기동
docker compose -p claude-mem -f docker-compose.my.yml up -d --build claude-mem-server claude-mem-worker
# worker가 새 라인을 쓰면 server /api/logs에 source=worker로 등장하는지
curl -s http://127.0.0.1:37700/api/logs | grep -E '\[worker\]' | head
# client(호스트)에서 WARN+ 로그 발생 후 [client] 등장 확인
npx @bjlee2024/claude-mem ... # (임의 hook 유발)
curl -s http://127.0.0.1:37700/api/logs | grep -E '\[client\]' | head
```
Expected: `[worker]`, `[client]` 태그 라인이 `/api/logs`에 나타남. web console에서 source 필터로 구분됨.

- [ ] **Step 5: 커밋 + 배포**

```bash
git add src/shared/SettingsDefaultsManager.ts docker-compose.my.yml
git commit -m "feat: default CLAUDE_MEM_LOG_FORWARD_LEVEL=WARN; wire log forwarding"
npm run build-and-sync   # 호스트 client plugin 갱신
```

---

## Self-Review 결과

- **Spec coverage:** §4.1 store→T1, §4.3 레벨게이트/forward→T2, §4.2 worker pull→T3, §4.4 API(ingest)→T4, client push→T5, §4.5 UI→T6, §4.6 설정+§8 배포→T7. 누락 없음.
- **Placeholder scan:** 모호 표현 없음. 단 T4 테스트 부트스트랩과 T5 내부 요청 헬퍼명은 "기존 패턴/헬퍼 재사용"으로 명시(실제 이름은 해당 파일에서 확인) — 구현 시 1줄 확인 필요한 알려진 지점.
- **Type consistency:** `ingestExternalLogs(lines, source)`, `drainForwardBuffer(): string[]`, `forwardLogs(lines)`, `parseLogLine(line).source` — task 간 일관.
- **알려진 검증 항목:** (a) server-beta가 자기 로그를 파일로도 쓰는지(쓴다면 T3 tail이 server 라인을 중복 수집 → source 판별/제외 필요). (b) `ServerBetaClient` 내부 요청 헬퍼명/`fetchImpl` 주입 지원 여부. 둘 다 해당 task 구현 첫 단계에서 파일 확인으로 해소.
