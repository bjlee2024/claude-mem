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
