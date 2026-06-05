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
