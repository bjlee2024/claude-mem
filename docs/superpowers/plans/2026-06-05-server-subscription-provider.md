# Server-Beta Subscription Generation Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the server-beta generation worker produce observations via a Claude **subscription** (OAuth token) instead of a metered `ANTHROPIC_API_KEY`, so a personal deployment generates at no per-token cost.

**Architecture:** A new `ClaudeSubscriptionObservationProvider` calls the same `POST /v1/messages` endpoint as the metered provider but authenticates with `Authorization: Bearer <oauth-token>` + an `anthropic-beta` OAuth flag (no `x-api-key`). It reuses the prompt builder, response parsing, and error classifier. Selection is via `CLAUDE_MEM_SERVER_PROVIDER=subscription`. No Agent SDK, no container image changes. Additive — existing providers unchanged.

**Tech Stack:** TypeScript, Bun test runner. Spec: `docs/superpowers/specs/2026-06-05-server-subscription-provider-design.md`.

---

## File Structure

- **Create:** `src/server/generation/providers/shared/claude-messages.ts` — shared Anthropic Messages helpers (response parse, body read, error classify) so both Claude providers DRY up.
- **Create:** `src/server/generation/providers/ClaudeSubscriptionObservationProvider.ts` — the OAuth-bearer provider.
- **Modify:** `src/server/generation/providers/ClaudeObservationProvider.ts` — import the shared helpers; re-export `classifyClaudeServerError` (an existing test imports it from here).
- **Modify:** `src/server/runtime/create-server-beta-service.ts` — add the `subscription` selection branch.
- **Modify:** `docker-compose.my.yml` — add `CLAUDE_CODE_OAUTH_TOKEN` to the worker; **Modify:** `docs/public/server-client-modes.mdx` — add a subscription section.
- **Test:** `tests/server/generation/claude-subscription-provider.test.ts`; extend `tests/server/generation/providers.test.ts` is NOT required (it must keep passing unchanged).

---

## Task 1: Extract shared Anthropic Messages helpers (no behavior change)

Pull the response parsing, body reader, and error classifier out of the metered provider into a shared module so the subscription provider reuses them. This is a pure refactor — the metered provider's tests must stay green.

**Files:**
- Create: `src/server/generation/providers/shared/claude-messages.ts`
- Modify: `src/server/generation/providers/ClaudeObservationProvider.ts`
- Test (existing, must stay green): `tests/server/generation/providers.test.ts`

- [ ] **Step 1: Create the shared module**

```ts
// src/server/generation/providers/shared/claude-messages.ts
// SPDX-License-Identifier: Apache-2.0
//
// Shared Anthropic Messages REST helpers used by both server-beta Claude
// providers (metered API key + subscription OAuth). Keeping the response
// parsing and error classification here means the two providers never diverge
// on how an Anthropic response becomes a ServerGenerationResult.
import { logger } from '../../../../utils/logger.js';
import {
  ServerClassifiedProviderError,
  parseRetryAfterMs,
} from './error-classification.js';
import type { ServerGenerationResult } from './types.js';

export const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

export function parseClaudeMessagesResponse(
  data: AnthropicMessagesResponse,
  opts: { model: string; providerLabel: ServerGenerationResult['providerLabel'] },
): ServerGenerationResult {
  const blocks = Array.isArray(data.content) ? data.content : [];
  const rawText = blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text!)
    .join('\n')
    .trim();

  if (!rawText) {
    logger.warn('SDK', 'Anthropic returned empty content array', {
      provider: opts.providerLabel,
      model: opts.model,
    });
  }

  const usage = data.usage ?? {};
  const tokensUsed =
    typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number'
      ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
      : undefined;

  return {
    rawText,
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    providerLabel: opts.providerLabel,
    modelId: opts.model,
  };
}

export async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export interface ClassifyInput {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
}

/**
 * Anthropic-specific HTTP error classification, shared by the metered and
 * subscription Claude providers. Subscription token expiry surfaces as 401/403
 * → auth_invalid.
 */
export function classifyClaudeServerError(input: ClassifyInput): ServerClassifiedProviderError {
  const status = input.status;
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();
  const retryAfterMs = input.headers ? parseRetryAfterMs(input.headers.get('retry-after')) : undefined;

  if (lower.includes('overloaded')) {
    return new ServerClassifiedProviderError(
      `Anthropic overloaded${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'transient', cause: input.cause },
    );
  }
  if (status === 401 || status === 403 || lower.includes('invalid api key')) {
    return new ServerClassifiedProviderError(
      `Anthropic auth invalid${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }
  if (status === 429) {
    return new ServerClassifiedProviderError('Anthropic rate limit (429)', {
      kind: 'rate_limit',
      cause: input.cause,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (lower.includes('quota exceeded')) {
    return new ServerClassifiedProviderError('Anthropic quota exhausted', {
      kind: 'quota_exhausted',
      cause: input.cause,
    });
  }
  if (
    lower.includes('prompt is too long') ||
    lower.includes('context window') ||
    lower.includes('max_tokens')
  ) {
    return new ServerClassifiedProviderError('Anthropic context overflow', {
      kind: 'unrecoverable',
      cause: input.cause,
    });
  }
  if (status === 529) {
    return new ServerClassifiedProviderError('Anthropic overloaded (529)', {
      kind: 'transient',
      cause: input.cause,
    });
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return new ServerClassifiedProviderError(`Anthropic upstream error (status ${status})`, {
      kind: 'transient',
      cause: input.cause,
    });
  }
  if (status === 400) {
    return new ServerClassifiedProviderError('Anthropic bad request (400)', {
      kind: 'unrecoverable',
      cause: input.cause,
    });
  }
  if (status === undefined) {
    const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
    return new ServerClassifiedProviderError(`Anthropic network error: ${message}`, {
      kind: 'transient',
      cause: input.cause,
    });
  }
  return new ServerClassifiedProviderError(
    `Anthropic API error: ${status}${body ? ` - ${body.substring(0, 200)}` : ''}`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}
```

- [ ] **Step 2: Refactor `ClaudeObservationProvider.ts` to use the shared module**

Replace the metered provider's body so it imports from the shared module and re-exports the classifier (the existing test imports `classifyClaudeServerError` from this file). New file content:

```ts
// src/server/generation/providers/ClaudeObservationProvider.ts
// SPDX-License-Identifier: Apache-2.0

import {
  ServerClassifiedProviderError,
} from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import {
  CLAUDE_MESSAGES_URL,
  ANTHROPIC_VERSION,
  classifyClaudeServerError,
  parseClaudeMessagesResponse,
  safeReadBody,
  type AnthropicMessagesResponse,
} from './shared/claude-messages.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

// Re-export so existing importers (and tests) keep resolving it from here.
export { classifyClaudeServerError } from './shared/claude-messages.js';

// #2554 — canonical default model; a server with no CLAUDE_MEM_SERVER_MODEL
// generates against a valid id instead of 404-ing.
export const DEFAULT_SERVER_CLAUDE_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MODEL = DEFAULT_SERVER_CLAUDE_MODEL;

export interface ClaudeObservationProviderOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
}

export class ClaudeObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClaudeObservationProviderOptions) {
    if (!options.apiKey) {
      throw new ServerClassifiedProviderError('Anthropic API key not configured', {
        kind: 'auth_invalid',
        cause: new Error('apiKey is required'),
      });
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
  ): Promise<ServerGenerationResult> {
    const { prompt, skippedAll } = buildServerGenerationPrompt(context);
    if (skippedAll) {
      return {
        rawText: '<skip_summary reason="all_events_private" />',
        providerLabel: this.providerLabel,
        modelId: this.model,
      };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(CLAUDE_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxOutputTokens,
          temperature: 0.3,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal,
      });
    } catch (networkError) {
      throw classifyClaudeServerError({ cause: networkError });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyClaudeServerError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`Anthropic API error: ${response.status} - ${bodyText}`),
      });
    }

    let data: AnthropicMessagesResponse;
    try {
      data = (await response.json()) as AnthropicMessagesResponse;
    } catch (parseError) {
      throw new ServerClassifiedProviderError('Anthropic returned invalid JSON', {
        kind: 'parse_error',
        cause: parseError,
      });
    }

    if (data.error) {
      throw classifyClaudeServerError({
        status: response.status,
        bodyText: `${data.error.type ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`Anthropic API error: ${data.error.type} - ${data.error.message}`),
      });
    }

    return parseClaudeMessagesResponse(data, { model: this.model, providerLabel: this.providerLabel });
  }
}
```

- [ ] **Step 3: Run the existing metered tests to verify no regression**

Run: `bun test tests/server/generation/providers.test.ts`
Expected: PASS (the metered provider's generate parsing + `classifyClaudeServerError` cases still resolve, now via the shared module + re-export).

- [ ] **Step 4: Commit**

```bash
git add src/server/generation/providers/shared/claude-messages.ts src/server/generation/providers/ClaudeObservationProvider.ts
git commit -m "refactor(server): extract shared Anthropic Messages helpers"
```

---

## Task 2: `ClaudeSubscriptionObservationProvider`

**Files:**
- Create: `src/server/generation/providers/ClaudeSubscriptionObservationProvider.ts`
- Test: `tests/server/generation/claude-subscription-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/generation/claude-subscription-provider.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { ClaudeSubscriptionObservationProvider } from '../../../src/server/generation/providers/ClaudeSubscriptionObservationProvider.js';
import type { ServerGenerationContext } from '../../../src/server/generation/providers/shared/types.js';

// Minimal context with one non-private event so buildServerGenerationPrompt does
// not flag skippedAll. Shape mirrors what other provider tests pass.
function makeContext(): ServerGenerationContext {
  return {
    job: { id: 'job-1' } as any,
    events: [
      {
        id: 'evt-1',
        eventType: 'tool_use',
        payload: { tool_name: 'Read', tool_input: { file_path: '/x' } },
        occurredAt: new Date('2026-06-05T00:00:00Z'),
      } as any,
    ],
    project: { projectId: 'p-1', teamId: 't-1', serverSessionId: null, projectName: 'demo' },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const OK_BODY = {
  content: [{ type: 'text', text: '<observation>ok</observation>' }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe('ClaudeSubscriptionObservationProvider', () => {
  it('sends OAuth Bearer + anthropic-beta and NO x-api-key', async () => {
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const fetchImpl = (async (url: any, init: any) => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(init.headers)) h[k.toLowerCase()] = String(v);
      captured = { url: String(url), headers: h };
      return jsonResponse(OK_BODY);
    }) as unknown as typeof fetch;

    const provider = new ClaudeSubscriptionObservationProvider({ oauthToken: 'sk-ant-oat01-abc', fetchImpl });
    const result = await provider.generate(makeContext());

    expect(captured!.url).toContain('/v1/messages');
    expect(captured!.headers['authorization']).toBe('Bearer sk-ant-oat01-abc');
    expect(captured!.headers['anthropic-beta']).toBeTruthy();
    expect('x-api-key' in captured!.headers).toBe(false);
    expect(result.rawText).toBe('<observation>ok</observation>');
    expect(result.tokensUsed).toBe(15);
    expect(result.providerLabel).toBe('claude');
    expect(result.modelId).toBe('claude-sonnet-4-6');
  });

  it('throws auth_invalid on an empty or non-oauth token (constructor)', () => {
    expect(() => new ClaudeSubscriptionObservationProvider({ oauthToken: '' })).toThrow();
    expect(() => new ClaudeSubscriptionObservationProvider({ oauthToken: 'sk-ant-api03-notoauth' })).toThrow();
  });

  it('classifies a 401 as auth_invalid', async () => {
    const fetchImpl = (async () => jsonResponse({ error: { type: 'authentication_error', message: 'expired' } }, 401)) as unknown as typeof fetch;
    const provider = new ClaudeSubscriptionObservationProvider({ oauthToken: 'sk-ant-oat01-abc', fetchImpl });
    let kind = '';
    try { await provider.generate(makeContext()); } catch (e: any) { kind = e.kind; }
    expect(kind).toBe('auth_invalid');
  });

  it('classifies a 429 as rate_limit and 529 as transient', async () => {
    const make = (status: number, body: unknown) =>
      new ClaudeSubscriptionObservationProvider({
        oauthToken: 'sk-ant-oat01-abc',
        fetchImpl: (async () => jsonResponse(body, status)) as unknown as typeof fetch,
      });
    let k429 = ''; try { await make(429, { error: { message: 'rate' } }).generate(makeContext()); } catch (e: any) { k429 = e.kind; }
    let k529 = ''; try { await make(529, { error: { message: 'overloaded' } }).generate(makeContext()); } catch (e: any) { k529 = e.kind; }
    expect(k429).toBe('rate_limit');
    expect(k529).toBe('transient');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/server/generation/claude-subscription-provider.test.ts`
Expected: FAIL — module not found.

> If `makeContext()`'s `events`/`job` shape causes `buildServerGenerationPrompt` to throw or set `skippedAll`, read `src/server/generation/providers/shared/prompt-builder.ts` and `shared/types.ts` and adjust the fixture so a single ordinary `tool_use` event yields `skippedAll === false`. Do NOT weaken the assertions.

- [ ] **Step 3: Implement the provider**

```ts
// src/server/generation/providers/ClaudeSubscriptionObservationProvider.ts
// SPDX-License-Identifier: Apache-2.0
//
// Server-beta generation via a Claude SUBSCRIPTION (OAuth token from
// `claude setup-token`) instead of a metered API key. Same Anthropic Messages
// endpoint as the metered provider, but authenticated with an OAuth bearer +
// the anthropic-beta OAuth flag, and NO x-api-key. Pure fetch — no Agent SDK,
// no claude-code process, no container image changes.
import { ServerClassifiedProviderError } from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import { DEFAULT_SERVER_CLAUDE_MODEL } from './ClaudeObservationProvider.js';
import {
  CLAUDE_MESSAGES_URL,
  ANTHROPIC_VERSION,
  classifyClaudeServerError,
  parseClaudeMessagesResponse,
  safeReadBody,
  type AnthropicMessagesResponse,
} from './shared/claude-messages.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

// The beta flag that lets a Claude Code OAuth token authenticate the public
// Messages API. Kept in one place so it is trivial to adjust if Anthropic
// changes the value (verify a live 200 during deploy).
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';

export interface ClaudeSubscriptionObservationProviderOptions {
  oauthToken: string;
  model?: string;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
}

export class ClaudeSubscriptionObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude' as const;
  private readonly oauthToken: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClaudeSubscriptionObservationProviderOptions) {
    const token = options.oauthToken ?? '';
    if (!token || !token.startsWith('sk-ant-oat')) {
      throw new ServerClassifiedProviderError(
        'Claude subscription OAuth token not configured (expected an sk-ant-oat… token from `claude setup-token`)',
        { kind: 'auth_invalid', cause: new Error('valid oauthToken is required') },
      );
    }
    this.oauthToken = token;
    this.model = options.model ?? DEFAULT_SERVER_CLAUDE_MODEL;
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
  ): Promise<ServerGenerationResult> {
    const { prompt, skippedAll } = buildServerGenerationPrompt(context);
    if (skippedAll) {
      return {
        rawText: '<skip_summary reason="all_events_private" />',
        providerLabel: this.providerLabel,
        modelId: this.model,
      };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(CLAUDE_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.oauthToken}`,
          'anthropic-beta': ANTHROPIC_OAUTH_BETA,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxOutputTokens,
          temperature: 0.3,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal,
      });
    } catch (networkError) {
      throw classifyClaudeServerError({ cause: networkError });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyClaudeServerError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`Anthropic API error: ${response.status} - ${bodyText}`),
      });
    }

    let data: AnthropicMessagesResponse;
    try {
      data = (await response.json()) as AnthropicMessagesResponse;
    } catch (parseError) {
      throw new ServerClassifiedProviderError('Anthropic returned invalid JSON', {
        kind: 'parse_error',
        cause: parseError,
      });
    }

    if (data.error) {
      throw classifyClaudeServerError({
        status: response.status,
        bodyText: `${data.error.type ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`Anthropic API error: ${data.error.type} - ${data.error.message}`),
      });
    }

    return parseClaudeMessagesResponse(data, { model: this.model, providerLabel: this.providerLabel });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/server/generation/claude-subscription-provider.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/generation/providers/ClaudeSubscriptionObservationProvider.ts tests/server/generation/claude-subscription-provider.test.ts
git commit -m "feat(server): ClaudeSubscriptionObservationProvider (OAuth bearer)"
```

---

## Task 3: Wire the `subscription` provider selection branch

**Files:**
- Modify: `src/server/runtime/create-server-beta-service.ts` (`buildServerGenerationProviderFromEnv`, ≈239)
- Test: `tests/server/generation/subscription-provider-selection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/generation/subscription-provider-selection.test.ts
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildServerGenerationProviderFromEnv } from '../../../src/server/runtime/create-server-beta-service.js';
import { ClaudeSubscriptionObservationProvider } from '../../../src/server/generation/providers/ClaudeSubscriptionObservationProvider.js';

describe('buildServerGenerationProviderFromEnv — subscription', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.CLAUDE_MEM_SERVER_PROVIDER;
    delete process.env.CLAUDE_MEM_SERVER_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_MEM_SERVER_MODEL;
  });
  afterEach(() => { process.env = { ...saved }; });

  it('returns a subscription provider when provider=subscription and a token is set', () => {
    process.env.CLAUDE_MEM_SERVER_PROVIDER = 'subscription';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-abc';
    const provider = buildServerGenerationProviderFromEnv();
    expect(provider).toBeInstanceOf(ClaudeSubscriptionObservationProvider);
  });

  it('prefers CLAUDE_MEM_SERVER_OAUTH_TOKEN over CLAUDE_CODE_OAUTH_TOKEN', () => {
    process.env.CLAUDE_MEM_SERVER_PROVIDER = 'subscription';
    process.env.CLAUDE_MEM_SERVER_OAUTH_TOKEN = 'sk-ant-oat01-primary';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-fallback';
    expect(buildServerGenerationProviderFromEnv()).toBeInstanceOf(ClaudeSubscriptionObservationProvider);
  });

  it('returns null when provider=subscription but no token is set', () => {
    process.env.CLAUDE_MEM_SERVER_PROVIDER = 'subscription';
    expect(buildServerGenerationProviderFromEnv()).toBeNull();
  });
});
```

> `buildServerGenerationProviderFromEnv` must be exported for this test. Check the function declaration in `create-server-beta-service.ts`; if it is not exported, add `export` to it (it is currently module-private). That single keyword is the only change to its signature.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/server/generation/subscription-provider-selection.test.ts`
Expected: FAIL — either `buildServerGenerationProviderFromEnv` is not exported (import error) or the subscription branch is missing so it returns null in the first test.

- [ ] **Step 3: Implement**

In `create-server-beta-service.ts`:
1. Ensure the function is exported: `export function buildServerGenerationProviderFromEnv(): ServerGenerationProvider | null {`.
2. Add the import near the other provider imports at the top of the file:

```ts
import { ClaudeSubscriptionObservationProvider } from '../generation/providers/ClaudeSubscriptionObservationProvider.js';
```

3. Add the branch inside the `try` block, right after the `if (provider === 'claude' || provider === 'anthropic') { ... }` block:

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

> The constructor throws `auth_invalid` for a malformed token. `buildServerGenerationProviderFromEnv` already wraps provider construction in `try { … } catch { return null; }`, so a bad token degrades to `null` (worker Disabled) rather than crashing startup — consistent with the other providers.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/server/generation/subscription-provider-selection.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the broader generation suite for no regression**

Run: `bun test tests/server/generation/`
Expected: PASS (existing provider/selection tests unaffected; Postgres-gated suites skip without a URL).

- [ ] **Step 6: Commit**

```bash
git add src/server/runtime/create-server-beta-service.ts tests/server/generation/subscription-provider-selection.test.ts
git commit -m "feat(server): select subscription provider via CLAUDE_MEM_SERVER_PROVIDER"
```

---

## Task 4: Docker + docs wiring

**Files:**
- Modify: `docker-compose.my.yml` (worker service env)
- Modify: `docs/public/server-client-modes.mdx`

- [ ] **Step 1: Add the OAuth token env to the worker service**

In `docker-compose.my.yml`, in the `claude-mem-worker` service `environment:` block, next to the existing provider keys, add:

```yaml
      # Subscription generation (no per-token API cost): set
      # CLAUDE_MEM_SERVER_PROVIDER=subscription and supply a long-lived OAuth
      # token from `claude setup-token` on the host. Prefer a secret/.env file
      # over an inline value.
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}
```

Leave the existing `CLAUDE_MEM_SERVER_PROVIDER: ${CLAUDE_MEM_SERVER_PROVIDER:-claude}` line as-is (operators set it to `subscription` via `.env`).

- [ ] **Step 2: Add a subscription section to the docs**

Append to `docs/public/server-client-modes.mdx`, before "## Notes & limits":

```mdx
## Generation with a subscription (no API cost)

By default the server's worker generates observations with a metered
`ANTHROPIC_API_KEY`. You can instead use a **Claude subscription**, so generation
costs nothing per token.

```bash
# 1. On the host, mint a long-lived OAuth token (interactive login, ~1 year):
claude setup-token            # prints sk-ant-oat01-...

# 2. Point the worker at subscription mode + the token (use a .env or secret file):
echo 'CLAUDE_MEM_SERVER_PROVIDER=subscription' >> .env
echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...' >> .env

# 3. Restart the stack:
sudo systemctl restart claude-mem      # or: docker compose up -d

# 4. Confirm the worker is generating (and no longer restart-looping):
docker compose -p claude-mem logs -f claude-mem-worker
```

<Note>
The token lasts about a year — re-run `claude setup-token` and update the env when
it expires. If you see `auth_invalid` errors in the worker logs, the token has
expired or is wrong.
</Note>
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.my.yml docs/public/server-client-modes.mdx
git commit -m "docs: subscription generation env + usage guide"
```

---

## Task 5: Build, deploy, live verification

Not a code task — confirm the OAuth path works end-to-end against the real Anthropic API.

- [ ] **Step 1: Build the plugin + rebuild the worker image**

Run (node is via mise; the npx-cli bundle needs bun):
```bash
export PATH="$HOME/.local/share/mise/installs/node/latest/bin:$HOME/.bun/bin:$PATH"
npm run build
docker compose -f docker-compose.my.yml build claude-mem-worker claude-mem-server
```
Expected: build succeeds; the rebuilt `plugin/scripts/server-beta-service.cjs` contains the subscription provider (`grep -c 'sk-ant-oat' plugin/scripts/server-beta-service.cjs` ≥ 1).

- [ ] **Step 2: Mint a token and configure the worker**

```bash
claude setup-token            # host; copy the sk-ant-oat01-... value
printf 'CLAUDE_MEM_SERVER_PROVIDER=subscription\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...\n' >> .env
```

- [ ] **Step 3: Restart and confirm the worker generates**

```bash
sudo systemctl restart claude-mem    # interactive sudo
docker compose -p claude-mem logs --since 2m claude-mem-worker
```
Expected: the worker stays up (no exit-0 restart loop) and logs show it consuming generation jobs without `auth_invalid`. If you see `auth_invalid` (401), the OAuth beta header value may be wrong — adjust `ANTHROPIC_OAUTH_BETA` in `ClaudeSubscriptionObservationProvider.ts`, rebuild, and retry.

- [ ] **Step 4: End-to-end memory generation**

Trigger a Claude Code session that records a few events for a project, then check that compressed observations appear:
```bash
curl -s "http://127.0.0.1:37700/api/observations?limit=5"
```
Expected: observation rows with generated `title`/`narrative` (proving the subscription worker produced them).

- [ ] **Step 5: Commit any rebuilt artifacts**

```bash
git add plugin/ && git commit -m "build: sync plugin artifacts for subscription provider" || echo "no artifact changes"
```

- [ ] **Step 6: Finish the branch**

Use superpowers:finishing-a-development-branch to merge / push to the fork (`origin`).

---

## Notes & Known Deviations

- **OAuth beta header is the one live unknown.** `ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20'` is isolated in one constant; if Anthropic rejects it (401 with a valid token), adjust that value during Task 5. Everything else reuses the proven metered path.
- **providerLabel stays `'claude'`** — downstream parsing/DB are unchanged; subscription vs metered is not distinguished in stored data (out of scope).
- **No image changes** — the subscription path is pure `fetch`; the worker needs no claude-code executable or Agent SDK for generation. (`claude setup-token` runs on the HOST, where the CLI already exists.)
- **Token expiry** surfaces as `auth_invalid` in logs; no auto-refresh (long-lived token; out of scope per spec).
- **`buildServerGenerationProviderFromEnv` becomes exported** solely so the selection test can call it — no behavior change.
