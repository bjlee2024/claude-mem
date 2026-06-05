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
