// SPDX-License-Identifier: Apache-2.0
//
// Phase 7 — Runtime selector for hook subcommands.
//
// Reads `CLAUDE_MEM_RUNTIME` from `~/.claude-mem/settings.json` (via
// `loadFromFileOnce`) and decides whether the hook should call the
// server-beta /v1 endpoints or fall through to the worker compat path.
//
// This module deliberately does not import worker code so that hooks
// running in server-beta mode can reach the runtime even when no worker
// is installed.

import { join } from 'node:path';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';
import { ServerBetaClient, type ServerBetaClientConfig } from './server-beta-client.js';
import { DATA_DIR } from '../../shared/paths.js';
import { ProjectResolver } from './project-resolver.js';
import { Spool } from './spool.js';
import { ClientWriter } from './client-write.js';

export type SelectedRuntime = 'worker' | 'server-beta' | 'client';

export interface ServerBetaRuntimeContext {
  runtime: 'server-beta';
  client: ServerBetaClient;
  projectId: string;
  serverBaseUrl: string;
}

export interface ClientRuntimeContext {
  runtime: 'client';
  client: ServerBetaClient;
  projectId: string | null; // null => resolve per-repo
  serverBaseUrl: string;
}

export interface WorkerRuntimeContext {
  runtime: 'worker';
}

export type RuntimeContext = ServerBetaRuntimeContext | ClientRuntimeContext | WorkerRuntimeContext;

export function normalizeRuntimeValue(raw: string | undefined): SelectedRuntime {
  const v = (raw ?? 'worker').trim().toLowerCase();
  if (v === 'server-beta') return 'server-beta';
  if (v === 'client') return 'client';
  return 'worker';
}

export function selectRuntime(): SelectedRuntime {
  return normalizeRuntimeValue(loadFromFileOnce().CLAUDE_MEM_RUNTIME);
}

export function buildServerBetaContext(): ServerBetaRuntimeContext | null {
  const settings = loadFromFileOnce();
  const serverBaseUrl = (settings.CLAUDE_MEM_SERVER_BETA_URL ?? '').trim();
  const apiKey = (settings.CLAUDE_MEM_SERVER_BETA_API_KEY ?? '').trim();
  const projectId = (settings.CLAUDE_MEM_SERVER_BETA_PROJECT_ID ?? '').trim();

  if (!serverBaseUrl) {
    logger.warn('HOOK', '[server-beta-fallback] reason=missing_base_url');
    return null;
  }
  if (!apiKey) {
    logger.warn('HOOK', '[server-beta-fallback] reason=missing_api_key');
    return null;
  }
  if (!projectId) {
    logger.warn('HOOK', '[server-beta-fallback] reason=missing_project_id');
    return null;
  }

  const config: ServerBetaClientConfig = {
    serverBaseUrl,
    apiKey,
  };
  return {
    runtime: 'server-beta',
    client: new ServerBetaClient(config),
    projectId,
    serverBaseUrl,
  };
}

export function buildClientRuntimeContext(): ClientRuntimeContext | null {
  const settings = loadFromFileOnce();
  const serverBaseUrl = (settings.CLAUDE_MEM_SERVER_BETA_URL ?? '').trim();
  const apiKey = (settings.CLAUDE_MEM_SERVER_BETA_API_KEY ?? '').trim();
  if (!serverBaseUrl) {
    logger.warn('HOOK', '[client-fallback] reason=missing_base_url');
    return null;
  }
  if (!apiKey) {
    logger.warn('HOOK', '[client-fallback] reason=missing_api_key');
    return null;
  }
  const projectId = (settings.CLAUDE_MEM_SERVER_BETA_PROJECT_ID ?? '').trim() || null;
  return {
    runtime: 'client',
    client: new ServerBetaClient({ serverBaseUrl, apiKey }),
    projectId,
    serverBaseUrl,
  };
}

export function resolveRuntimeContext(): RuntimeContext {
  const selected = selectRuntime();
  if (selected === 'server-beta') {
    return buildServerBetaContext() ?? { runtime: 'worker' };
  }
  if (selected === 'client') {
    return buildClientRuntimeContext() ?? { runtime: 'worker' };
  }
  return { runtime: 'worker' };
}

export interface ClientContext {
  client: ServerBetaClient;
  resolver: ProjectResolver;
  spool: Spool;
  writer: ClientWriter;
  fixedProjectId: string | null;
}

// Client/server split — assemble the per-hook thin-client wiring from a remote
// runtime context. Accepts both 'client' and 'server-beta' contexts (the latter
// reuses this path as a single fixed-project pool).
export function buildClientContext(ctx: ServerBetaRuntimeContext | ClientRuntimeContext): ClientContext {
  const resolver = new ProjectResolver({ client: ctx.client, mapPath: join(DATA_DIR, 'project-map.json') });
  const spool = new Spool({ path: join(DATA_DIR, 'spool', 'pending.ndjson') });
  const fixedProjectId = ctx.projectId ?? null;
  const writer = new ClientWriter({ client: ctx.client, resolver, spool, fixedProjectId });
  return { client: ctx.client, resolver, spool, writer, fixedProjectId };
}

export function logServerBetaFallback(reason: string, details?: Record<string, unknown>): void {
  logger.warn('HOOK', `[server-beta-fallback] reason=${reason}`, details ?? {});
}
