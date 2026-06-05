# Server-Beta Subscription Generation Provider — Design Spec

**Date:** 2026-06-05
**Status:** Approved (brainstorming)
**Branch:** `feat/server-subscription-provider`

## Goal

Let the server-beta generation worker produce observations using a **Claude
subscription** (OAuth token) instead of a metered `ANTHROPIC_API_KEY`, so a
personal deployment can run generation at no per-token API cost. Additive: the
existing `claude` / `gemini` / `openrouter` metered providers are unchanged.

## Context / Decisions (from brainstorming)

- **Why:** the worker's only job is to call an LLM to compress raw events into
  observations; that call needs a provider credential. Today only metered API
  keys are supported on the server, so a key-less worker restart-loops.
- **Token strategy:** a **long-lived OAuth token** from `claude setup-token`
  (lasts ~1 year), injected into the worker via env/secret. No refresh
  infrastructure. Re-run on expiry. (Host-side auto-sync refresher is out of
  scope.)
- **Call mechanism (Approach A):** call the **same `/v1/messages` endpoint** as
  the metered provider, but authenticate with `Authorization: Bearer <oauth>` +
  an `anthropic-beta` OAuth flag instead of `x-api-key`. Lightweight — NO Agent
  SDK, NO claude-code process spawn, NO container image changes. Server
  generation is pure text-in/text-out, so the agent runtime is unnecessary.
  (Approach B — Agent SDK `query()` like the local worker — is left as a future
  fallback behind the same interface.)

## What already exists (reuse, don't rebuild)

- `ServerGenerationProvider` interface (`src/server/generation/providers/shared/types.ts:30`):
  `generate(context, signal?) → { rawText, tokensUsed?, providerLabel, modelId? }`.
- `ClaudeObservationProvider` (`src/server/generation/providers/ClaudeObservationProvider.ts`):
  the metered impl — `POST https://api.anthropic.com/v1/messages` with `x-api-key`,
  `buildServerGenerationPrompt(context)` for the prompt, content/usage parsing,
  and `classifyClaudeServerError()` (`auth_invalid`/`rate_limit`/`transient`/
  `unrecoverable`).
- Provider selection: `buildServerGenerationProviderFromEnv()`
  (`src/server/runtime/create-server-beta-service.ts:239`) switches on
  `CLAUDE_MEM_SERVER_PROVIDER` and reads the matching key; returns `null` → the
  worker manager becomes `Disabled` (the restart-loop cause).
- Local worker subscription path (the conceptual precedent, NOT reused here):
  `src/services/worker/ClaudeProvider.ts` uses the Agent SDK + OAuth via
  `EnvManager.buildIsolatedEnvWithFreshOAuth`.

## Architecture

```
CLAUDE_MEM_SERVER_PROVIDER=subscription
  → buildServerGenerationProviderFromEnv()  [new branch]
      → ClaudeSubscriptionObservationProvider({ oauthToken, model })   [new file]
          → generate(context)
              → buildServerGenerationPrompt(context)        (reused)
              → POST https://api.anthropic.com/v1/messages  (OAuth Bearer headers)
              → parse content/usage                         (shared helper)
              → { rawText, tokensUsed, providerLabel:'claude', modelId }
```

Downstream (`ProviderObservationGenerator` → `processGeneratedResponse`) is
unchanged; `providerLabel: 'claude'` keeps the parser/DB path identical.

## Components

### 1. `ClaudeSubscriptionObservationProvider` (new)

`src/server/generation/providers/ClaudeSubscriptionObservationProvider.ts`,
implements `ServerGenerationProvider`.

- **Constructor** `{ oauthToken: string; model?: string; maxOutputTokens?: number; fetchImpl?: typeof fetch }`.
  Throw a clear `ServerClassifiedProviderError({ kind: 'auth_invalid' })` if the
  token is empty or doesn't look like an OAuth token (does not start with
  `sk-ant-oat`). Default model = the metered provider's default
  (`claude-sonnet-4-6`); `maxOutputTokens` default 4096.
- **`generate(context, signal)`**:
  1. `const { prompt, skippedAll } = buildServerGenerationPrompt(context)`. If
     `skippedAll`, return the same skip result the metered provider returns (no
     network call).
  2. `POST https://api.anthropic.com/v1/messages` with body
     `{ model, max_tokens, temperature: 0.3, messages: [{ role:'user', content: prompt }] }`
     and headers (see Auth).
  3. Parse: join `data.content[].text` → `rawText`; `data.usage.input_tokens +
     output_tokens` → `tokensUsed`; return `{ rawText, tokensUsed,
     providerLabel: 'claude', modelId: model }`.
  4. On non-OK response, throw via the shared error classifier (see Error handling).

### 2. Auth headers (the only real difference vs metered)

Collect headers in ONE place (a small constant/builder) so the exact OAuth flag
is easy to adjust:

```
Authorization: Bearer <oauthToken>
anthropic-beta: oauth-2025-04-20
anthropic-version: 2023-06-01
Content-Type: application/json
```

`x-api-key` MUST be absent (sending both conflicts). **Implementation
verification:** the exact `anthropic-beta` value / requirement is an
Anthropic-controlled beta; confirm a live `200` during the deploy step and adjust
the constant if needed.

### 3. Shared response-parsing helper

Extract the metered provider's success-response parsing (content join + usage
extraction) into a shared helper (e.g. `parseClaudeMessagesResponse(data)`) so
both providers use it. `classifyClaudeServerError()` is already shared — reuse it
as-is; subscription token expiry surfaces as HTTP 401/403 → `auth_invalid`.

### 4. Provider selection branch

`src/server/runtime/create-server-beta-service.ts`, in
`buildServerGenerationProviderFromEnv()`:

```ts
if (provider === 'subscription') {
  const token = process.env.CLAUDE_MEM_SERVER_OAUTH_TOKEN
             ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
  if (!token) return null;
  const opts: { oauthToken: string; model?: string } = { oauthToken: token };
  if (process.env.CLAUDE_MEM_SERVER_MODEL) opts.model = process.env.CLAUDE_MEM_SERVER_MODEL;
  return new ClaudeSubscriptionObservationProvider(opts);
}
```

### 5. Docker / config wiring

`docker-compose.my.yml` worker service:
```yaml
CLAUDE_MEM_SERVER_PROVIDER: ${CLAUDE_MEM_SERVER_PROVIDER:-claude}
CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}
```
Prefer the existing credentials-file mount over an inline secret. NO image
changes (pure `fetch`; no claude-code executable or SDK needed in the worker for
this path).

## Error handling

| HTTP | classify | behavior |
| --- | --- | --- |
| 401 / 403 | `auth_invalid` | fail job + one-time clear log: "subscription token expired/invalid — re-run `claude setup-token` on the host and update the worker env" |
| 429 | `rate_limit` | existing BullMQ backoff/retry |
| 5xx / 529 | `transient` | retry |
| 400 / context overflow | `unrecoverable` | permanent job failure |

Long-lived token → no always-on refresh; expiry is surfaced via the 401 log
(no separate stale-marker file — YAGNI).

## Operations (documented)

```bash
claude setup-token                 # host, once → sk-ant-oat01-... (interactive login)
echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...' >> .env
echo 'CLAUDE_MEM_SERVER_PROVIDER=subscription' >> .env
sudo systemctl restart claude-mem  # or: docker compose up -d
docker compose -p claude-mem logs -f claude-mem-worker
```
Requires claude-code CLI on the host (already present). Re-run on ~1yr expiry.
Add a "generation at no API cost (subscription)" section to
`docs/public/server-client-modes.mdx`.

## Testing

- **Unit (no network, inject `fetchImpl`)** — `ClaudeSubscriptionObservationProvider`:
  headers correct (`Authorization: Bearer`, `anthropic-beta` present, `x-api-key`
  ABSENT); success parse (`rawText`, `tokensUsed`, `providerLabel:'claude'`,
  `modelId`); `skippedAll` → skip, no fetch; 401→`auth_invalid`(with expiry
  message), 429→`rate_limit`, 5xx→`transient`, 400→`unrecoverable`; empty/
  malformed token → constructor `auth_invalid`.
- **Unit (provider selection)** — `buildServerGenerationProviderFromEnv`:
  `subscription` + token → subscription provider; no token → `null`; existing
  `claude/gemini/openrouter` branches unregressed.
- **Live manual (deploy phase)** — with a real `setup-token` token: worker leaves
  the restart loop, a session produces a compressed observation visible via
  `/api/observations`; confirms the live OAuth-header behavior.

## Out of scope

- Token auto-refresh / host-keychain sync refresher.
- Keychain reads in the provider (containers can't; env-only).
- Agent SDK `query()` path (Approach B) — interface left open, not implemented.
- Automating `claude setup-token`.
- Fine-grained subscription quota management beyond the existing 429 backoff.
