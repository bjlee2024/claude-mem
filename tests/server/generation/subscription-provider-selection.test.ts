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
    const provider = buildServerGenerationProviderFromEnv();
    expect(provider).toBeInstanceOf(ClaudeSubscriptionObservationProvider);
    expect((provider as any).oauthToken).toBe('sk-ant-oat01-primary');
  });

  it('returns null when provider=subscription but no token is set', () => {
    process.env.CLAUDE_MEM_SERVER_PROVIDER = 'subscription';
    expect(buildServerGenerationProviderFromEnv()).toBeNull();
  });

  it('returns null when provider=subscription but the token is malformed', () => {
    process.env.CLAUDE_MEM_SERVER_PROVIDER = 'subscription';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'not-an-oat-token';
    expect(buildServerGenerationProviderFromEnv()).toBeNull();
  });
});
