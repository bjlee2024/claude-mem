# Claude-Mem Server (Beta)

Claude-Mem Server is the beta server runtime for Claude-Mem 13. It is a
Postgres-backed, BullMQ-driven, API-key-authenticated runtime that replaces
the legacy `claude-mem worker` for deployable use cases.

## Architecture

```
                +-------------------+
                |  Hooks / SDK / MCP|
                |    (clients)      |
                +---------+---------+
                          |  HTTPS / Bearer API key
                          v
+-----------------+  +----+---------+   +-------------------+
|    Postgres     |<-+ claude-mem-  +-->+      Valkey       |
| (canonical      |  |   server      |   | (BullMQ queue,   |
|  storage:       |  | --daemon      |   |  noeviction,     |
|  events,        |  | HTTP only,    |   |  appendonly yes) |
|  observations,  |  | no generation |   +---------+---------+
|  jobs, sessions,|  +-------+-------+             ^
|  api_keys)      |          | enqueue              | poll
+--------^--------+          |                      |
         |                   v                      |
         |          +-----------------+             |
         +----------+ claude-mem-     +-------------+
            read    |  worker (Nx)    |  consume jobs
            write   | server worker   |  call provider
                    |  start          |
                    +-----------------+
```

The HTTP service and the BullMQ generation worker run from the **same image
and same codebase**, but are split into separate processes / containers so
that:

1. Long-running provider calls cannot block HTTP responsiveness.
2. Generation can scale horizontally (`docker compose up --scale claude-mem-worker=N`).
3. Restarting the HTTP server does not lose enqueued generation work — jobs
   live in Valkey, persisted by AOF.

The legacy `claude-mem worker` runtime is **not** spawned in Docker. The
container entrypoint runs `bun server-beta-service.cjs --daemon` (or
`worker start`) and never `bun worker-service.cjs`.

## Required environment variables

`validateServerBetaEnv()` runs at startup and refuses to boot when any of
the following are missing or invalid in Docker:

| Variable                          | Required | Notes                                                        |
|-----------------------------------|----------|--------------------------------------------------------------|
| `CLAUDE_MEM_RUNTIME`              | Docker   | Must be `server-beta` in Docker (warned otherwise).          |
| `CLAUDE_MEM_QUEUE_ENGINE`         | Docker   | Must be `bullmq`. In-process queues are rejected in Docker.  |
| `CLAUDE_MEM_SERVER_DATABASE_URL`  | Always   | Postgres connection string. Fails fast at startup.           |
| `CLAUDE_MEM_REDIS_URL`            | bullmq   | Required when queue engine is `bullmq`.                      |
| `CLAUDE_MEM_AUTH_MODE`            | Always   | Must NOT be `local-dev` in Docker.                           |
| `CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS` | Docker | Must NOT be `1`/`true` in Docker.                            |
| `CLAUDE_MEM_GENERATION_DISABLED`  | Optional | Set to `true` on the HTTP service when running a separate worker. |
| `CLAUDE_MEM_SERVER_PROVIDER`      | Worker   | One of `claude`, `gemini`, `openrouter`. Worker only.        |
| `ANTHROPIC_API_KEY` (or alt)      | Worker   | Required by the chosen provider.                             |

Local development can still use SQLite + `local-dev` auth bypass **outside
Docker only**. Deployable mode must use the table above.

## Generation worker mode (`claude-mem server worker start`)

The same image runs the generation worker via:

```sh
claude-mem server worker start
```

This starts a process that:

* Connects to Postgres and Valkey using the same configuration as the HTTP
  service.
* Attaches BullMQ Workers to the `event` and `summary` queues.
* Never opens an HTTP listener.
* Blocks in the foreground (good for `docker run`, `kubectl run`, systemd).
* Forces generation enabled even if `CLAUDE_MEM_GENERATION_DISABLED=true`
  is inherited from the shared compose file. The worker IS the generation
  process.

In Compose this is the `claude-mem-worker` service. Scale it horizontally:

```sh
docker compose up -d --scale claude-mem-worker=4
```

BullMQ guarantees only one worker processes a given job at a time; the
provider call inside `ProviderObservationGenerator.process` is idempotent
on the `job.id` (`evt_<sha256>` / `sum_<sha256>`) so retries cannot
duplicate observations.

## 프로덕션 인증

```sh
CLAUDE_MEM_AUTH_MODE=api-key
```

`CLAUDE_MEM_AUTH_MODE=api-key`는 **서버 측** 설정이자 기본값입니다
(`requireServerAuth`는 이 변수가 설정되지 않으면 `'api-key'`로
fallback합니다). 이는 **모든 요청이 bearer 키를 지녀야 함**을 의미합니다:

```
Authorization: Bearer <raw-key>
```

키가 없는 요청은 `401 Unauthorized`, 키가 무효하거나 필요한 scope가
부족한 요청은 `403 Forbidden`을 받습니다
(`src/server/middleware/auth.ts`). 따라서 **원격 클라이언트는 항상 API
키가 필요하며** 익명 접근은 없습니다. 유일한 예외는 `local-dev` loopback
우회인데, 이는 `127.0.0.1`을 요구하고 Docker에서는 거부됩니다(아래 경고
참고). 원격 클라이언트는 결코 이 예외에 해당될 수 없습니다.

### 키가 필요한가, 그리고 어디서 확인하나?

네 — 원격 클라이언트는 키 없이 `api-key` 서버와 통신할 수 없습니다.
키는 **생성 후 조회할 수 없습니다**: Postgres에는 salted 해시만
저장되며(`api_keys.key_hash`) raw 값은 절대 저장되지 않습니다. `api-key
list`는 메타데이터와 비밀이 아닌 `prefix`를 보여주지만 키 자체는
보여주지 **않습니다**.

> 키를 분실했다면 조회할 수 없으니, 새 키를 발급하고(아래) 기존 키를
> 폐기하세요. 기존 키/디바이스에는 영향이 없습니다.

### 1. 키 생성 (서버 호스트에서)

```sh
claude-mem server api-key create \
  --name "ci"                  \
  --scope memories:read,memories:write
```

플래그:

| 플래그 | 기본값 | 비고 |
|------|---------|-------|
| `--name`    | `server-api-key` | `list`에 표시되는 사람용 라벨. 클라이언트/디바이스별로 하나씩 두면 해당 키만 폐기할 수 있습니다. |
| `--scope`   | `memories:read,memories:write` | 쉼표로 구분. 생략하면 읽기+쓰기 기본값; 권한이 큰 admin 키에만 `*`를 사용하세요. |
| `--team`    | 없음 | 키를 특정 팀으로 제한. |
| `--project` | 없음 | 키를 단일 프로젝트로 제한. repo별로 프로젝트를 해석하는 클라이언트는 비워두세요. |

JSON이 출력되며, `key` 필드가 **단 한 번만 표시되는 raw 키**입니다 — 지금
복사하세요:

```json
{
  "id": "ak_…",
  "key": "cmk_…",          // ← raw bearer 키, 즉시 복사할 것
  "name": "ci",
  "scopes": ["memories:read", "memories:write"]
}
```

> 서버 측 명령(`api-key create|list|revoke`, `enroll`)은 데이터베이스
> 접근이 필요하므로, `CLAUDE_MEM_SERVER_DATABASE_URL`이 서버의 Postgres를
> 가리키는 곳(보통 서버 호스트)에서 실행하세요. Postgres가 호스트로
> 노출되지 않았다면 Postgres 컨테이너 주소를 사용하세요.

### 2. 클라이언트에 키 전달

한 줄 enrollment 토큰에 묶어 전달하거나(권장 — [Server & Client
Modes](public/server-client-modes.mdx) 참고):

```sh
claude-mem server enroll --url http://<server-reachable-host>:37877 --label laptop
# → npx @bjlee2024/claude-mem install --mode client --enroll <token>
```

Docker 스택만 돌고 호스트에 `claude-mem`이 PATH에 없으면, compose 프로젝트
루트(`.env`와 `dist/npx-cli/index.js`가 있는 곳)에서 실행합니다. `.env`의
DSN은 컨테이너 호스트명 `postgres`를 쓰므로, 호스트 CLI가 닿게 컨테이너
IP로 바꿉니다:

```sh
bash -lc '
    set -a && source .env && set +a
    PG_IP=$(docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" claude-mem-postgres-1)
    export CLAUDE_MEM_SERVER_DATABASE_URL="${CLAUDE_MEM_SERVER_DATABASE_URL/@postgres:/@$PG_IP:}"
    node dist/npx-cli/index.js server enroll --url http://10.100.16.183:37700 --label client_name
'
```

…또는 raw 키를 클라이언트에 직접 전달:

```sh
npx @bjlee2024/claude-mem install --mode client \
  --server-url http://<server-reachable-host>:37877 \
  --token <raw-key>
```

두 방식 모두 `CLAUDE_MEM_SERVER_BETA_API_KEY`(및
`CLAUDE_MEM_SERVER_BETA_URL`)를 클라이언트의 `~/.claude-mem` 설정에 모드
`0600`으로 기록합니다. 클라이언트는 매 요청마다 이 키를 bearer로
전송합니다.

### 3. 목록 조회 및 폐기

```sh
claude-mem server api-key list           # id, name, prefix, scope, status — raw 키는 표시 안 됨
claude-mem server api-key revoke <id>    # id는 `list`에서 확인
```

`requirePostgresServerAuth`가 매 호출마다 해시로 행을 다시 로드하므로
폐기는 모든 요청에 적용됩니다. 메모리 캐시가 없어 우회가 불가능하며 —
폐기된 키는 다음 사용 시 실패합니다(`401`/`403`).

> **Docker에서 `CLAUDE_MEM_AUTH_MODE=local-dev`를 활성화하지 마세요.**
> loopback 우회는 요청이 HTTP 리스너의 `127.0.0.1`에서 비롯됨에
> 의존하는데, 이는 컨테이너 내부에서 유의미한 경계가 아닙니다. 시작
> 검증기가 이 조합으로는 부팅을 거부하고 0이 아닌 종료 코드를
> 반환합니다.

## Compose stack

`docker-compose.yml` ships four services:

* `postgres` — canonical storage. Schema is bootstrapped at startup by
  `bootstrapServerBetaPostgresSchema()`.
* `valkey` — BullMQ queue, configured with `appendonly yes`,
  `appendfsync everysec`, `maxmemory-policy noeviction`.
* `claude-mem-server` — HTTP runtime.
  `CLAUDE_MEM_GENERATION_DISABLED=true` so the BullMQ Worker is **not**
  attached here.
* `claude-mem-worker` — generation worker. Scale horizontally.

Bring it up:

```sh
docker compose up -d --build
```

Tear it down (and wipe data):

```sh
docker compose down -v
```

## End-to-end test

`scripts/e2e-server-beta-docker.sh` brings up the full stack and verifies:

* `POST /v1/events?wait=true` returns a `generationJob` descriptor.
* Restart of `claude-mem-server` and `claude-mem-worker` mid-stream does
  not lose data.
* Revoking an API key denies subsequent reads and writes (401/403).
* No `worker-service.cjs` process runs in any container.
* `CLAUDE_MEM_AUTH_MODE=local-dev` is rejected inside Docker.
