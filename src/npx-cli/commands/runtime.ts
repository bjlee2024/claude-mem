import { spawnHidden } from '../../shared/spawn.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { existsSync } from 'fs';
import { join } from 'path';
import pc from 'picocolors';
import { resolveBunBinaryPath } from '../utils/bun-resolver.js';
import { isPluginInstalled, marketplaceDirectory } from '../utils/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import {
  selectRuntime,
  buildClientRuntimeContext,
  buildServerBetaContext,
} from '../../services/hooks/runtime-selector.js';
import { ProjectResolver } from '../../services/hooks/project-resolver.js';
import { DATA_DIR } from '../../shared/paths.js';

function ensureInstalledOrExit(): void {
  if (!isPluginInstalled()) {
    console.error(pc.red('claude-mem is not installed.'));
    console.error(`Run: ${pc.bold('npx @bjlee2024/claude-mem install')}`);
    process.exit(1);
  }
}

function resolveBunOrExit(): string {
  const bunPath = resolveBunBinaryPath();
  if (!bunPath) {
    console.error(pc.red('Bun not found.'));
    console.error('Install Bun: https://bun.sh');
    console.error('After installation, restart your terminal.');
    process.exit(1);
  }
  return bunPath;
}

function workerServiceScriptPath(): string {
  return join(marketplaceDirectory(), 'plugin', 'scripts', 'worker-service.cjs');
}

function serverBetaServiceScriptPath(): string {
  return join(marketplaceDirectory(), 'plugin', 'scripts', 'server-beta-service.cjs');
}

function spawnBunWorkerCommand(command: string, extraArgs: string[] = []): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();
  const workerScript = workerServiceScriptPath();

  if (!existsSync(workerScript)) {
    console.error(pc.red(`Worker script not found at: ${workerScript}`));
    console.error('The installation may be corrupted. Try: npx @bjlee2024/claude-mem install');
    process.exit(1);
  }

  const args = [workerScript, command, ...extraArgs];

  const child = spawnHidden(bunPath, args, {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    // Sanitize host CLI bleed-through and Anthropic credentials before
    // launching the Bun worker/server/transcript process. Credentials are
    // re-read from ~/.claude-mem/.env at SDK spawn time (#2357 / #2375).
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(pc.red(`Failed to start Bun: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}

function spawnBunServerBetaCommand(command: string, extraArgs: string[] = []): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();
  const serverScript = serverBetaServiceScriptPath();

  if (!existsSync(serverScript)) {
    console.error(pc.red(`Server beta script not found at: ${serverScript}`));
    console.error('The installation may be corrupted. Try: npx @bjlee2024/claude-mem install');
    process.exit(1);
  }

  const child = spawnHidden(bunPath, [serverScript, command, ...extraArgs], {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    // Sanitize host CLI bleed-through and Anthropic credentials before
    // launching the Bun worker/server/transcript process. Credentials are
    // re-read from ~/.claude-mem/.env at SDK spawn time (#2357 / #2375).
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(pc.red(`Failed to start Bun: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}

export function runServerBetaStartCommand(): void {
  spawnBunServerBetaCommand('start');
}

export function runServerBetaStopCommand(): void {
  spawnBunServerBetaCommand('stop');
}

export function runServerBetaRestartCommand(): void {
  spawnBunServerBetaCommand('restart');
}

export function runServerBetaStatusCommand(): void {
  spawnBunServerBetaCommand('status');
}

// Phase 10 — start the BullMQ generation worker (no HTTP). Use this in
// Compose to scale generation horizontally while a single (or multiple)
// HTTP-only server-beta replicas serve writes/reads.
export function runServerBetaWorkerStartCommand(): void {
  spawnBunServerBetaCommand('worker', ['start']);
}

export function runStartCommand(): void {
  spawnBunWorkerCommand('start');
}

export function runStopCommand(): void {
  spawnBunWorkerCommand('stop');
}

export function runRestartCommand(): void {
  spawnBunWorkerCommand('restart');
}

export function runStatusCommand(): void {
  spawnBunWorkerCommand('status');
}

export function runServerApiKeyCommand(extraArgs: string[] = []): void {
  spawnBunWorkerCommand('server', ['api-key', ...extraArgs]);
}

export function runAdoptCommand(extraArgs: string[] = []): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();
  const workerScript = workerServiceScriptPath();

  if (!existsSync(workerScript)) {
    console.error(pc.red(`Worker script not found at: ${workerScript}`));
    console.error('The installation may be corrupted. Try: npx @bjlee2024/claude-mem install');
    process.exit(1);
  }

  const userCwd = process.cwd();
  const args = [workerScript, 'adopt', '--cwd', userCwd, ...extraArgs];

  const child = spawnHidden(bunPath, args, {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    // Sanitize host CLI bleed-through and Anthropic credentials before
    // launching the Bun worker/server/transcript process. Credentials are
    // re-read from ~/.claude-mem/.env at SDK spawn time (#2357 / #2375).
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(pc.red(`Failed to start Bun: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}

export function runCleanupCommand(extraArgs: string[] = []): void {
  spawnBunWorkerCommand('cleanup', extraArgs);
}

export async function runSearchCommand(queryParts: string[]): Promise<void> {
  ensureInstalledOrExit();

  const query = queryParts.join(' ').trim();
  if (!query) {
    console.error(pc.red('Usage: npx @bjlee2024/claude-mem search <query>'));
    process.exit(1);
  }

  const runtime = selectRuntime();

  if (runtime === 'client' || runtime === 'server-beta') {
    // Route to remote server's /v1/search endpoint via ServerBetaClient.
    const ctx = runtime === 'server-beta' ? buildServerBetaContext() : buildClientRuntimeContext();
    if (!ctx) {
      console.error(pc.red(
        runtime === 'server-beta'
          ? 'server-beta runtime selected but configuration is incomplete (missing CLAUDE_MEM_SERVER_BETA_URL, CLAUDE_MEM_SERVER_BETA_API_KEY, or CLAUDE_MEM_SERVER_BETA_PROJECT_ID).'
          : 'client runtime selected but CLAUDE_MEM_SERVER_BETA_URL or CLAUDE_MEM_SERVER_BETA_API_KEY is missing.',
      ));
      process.exit(1);
    }

    let projectId = ctx.projectId;
    if (!projectId) {
      // client mode with no fixed project — resolve from current repo name
      const resolver = new ProjectResolver({ client: ctx.client, mapPath: join(DATA_DIR, 'project-map.json') });
      try {
        projectId = await resolver.resolve(process.cwd());
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(pc.red(`Failed to resolve project from cwd: ${message}`));
        process.exit(1);
      }
    }

    let data: unknown;
    try {
      data = await ctx.client.searchObservations({ projectId, query });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(pc.red(`Search failed: ${message}`));
      process.exit(1);
    }

    if (typeof data === 'object' && data !== null) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(data);
    }
    return;
  }

  // Worker path (runtime === 'worker') — unchanged.
  const workerPort = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
  const searchUrl = `http://127.0.0.1:${workerPort}/api/search?query=${encodeURIComponent(query)}`;

  let response: Response;
  try {
    response = await fetch(searchUrl);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? (error as any).cause : undefined;
    if (cause?.code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      console.error(pc.red('Worker is not running.'));
      console.error(`Start it with: ${pc.bold('npx @bjlee2024/claude-mem start')}`);
      process.exit(1);
    }
    console.error(pc.red(`Search failed: ${message}`));
    process.exit(1);
  }

  if (!response.ok) {
    if (response.status === 404) {
      console.error(pc.red('Search endpoint not found. Is the worker running?'));
      console.error(`Try: ${pc.bold('npx @bjlee2024/claude-mem start')}`);
      process.exit(1);
    }
    console.error(pc.red(`Search failed: HTTP ${response.status}`));
    process.exit(1);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(`Search failed: invalid JSON response (${message})`));
    process.exit(1);
  }

  if (typeof data === 'object' && data !== null) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

/**
 * Fetch a project's FULL timeline. Backs the timeline-report / weekly-digests
 * skills across runtimes:
 *  - client/server-beta: paginate POST /v1/timeline and print JSON { observations }
 *    (all observations incl. kind='summary', oldest-first).
 *  - worker: proxy GET /api/context/inject?...&full=true and print the rendered text.
 *
 * Flags: --project <name> (override cwd-derived project), --limit <n> (page size).
 */
export async function runTimelineCommand(args: string[] = []): Promise<void> {
  ensureInstalledOrExit();

  let projectOverride: string | undefined;
  let pageSize = 200;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) { projectOverride = args[++i]; continue; }
    if (args[i] === '--limit' && args[i + 1]) { pageSize = Math.max(1, Math.min(500, parseInt(args[++i], 10) || 200)); continue; }
  }

  const runtime = selectRuntime();

  if (runtime === 'client' || runtime === 'server-beta') {
    const ctx = runtime === 'server-beta' ? buildServerBetaContext() : buildClientRuntimeContext();
    if (!ctx) {
      console.error(pc.red(
        runtime === 'server-beta'
          ? 'server-beta runtime selected but configuration is incomplete (missing CLAUDE_MEM_SERVER_BETA_URL, CLAUDE_MEM_SERVER_BETA_API_KEY, or CLAUDE_MEM_SERVER_BETA_PROJECT_ID).'
          : 'client runtime selected but CLAUDE_MEM_SERVER_BETA_URL or CLAUDE_MEM_SERVER_BETA_API_KEY is missing.',
      ));
      process.exit(1);
    }

    let projectId = projectOverride ? undefined : ctx.projectId;
    if (!projectId) {
      const resolver = new ProjectResolver({ client: ctx.client, mapPath: join(DATA_DIR, 'project-map.json') });
      try {
        projectId = await resolver.resolve(projectOverride ?? process.cwd());
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(pc.red(`Failed to resolve project: ${message}`));
        process.exit(1);
      }
    }

    const observations: unknown[] = [];
    let offset = 0;
    try {
      // Paginate until a page returns fewer than the page size (or empty).
      for (;;) {
        const page = await ctx.client.timelineObservations({ projectId, limit: pageSize, offset });
        observations.push(...page.observations);
        if (!page.hasMore || page.observations.length === 0) break;
        offset += page.observations.length;
        if (observations.length > 100000) break; // hard safety cap
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(pc.red(`Timeline fetch failed: ${message}`));
      process.exit(1);
    }

    // Server returns newest-first per page; present oldest-first for a timeline.
    observations.reverse();
    console.log(JSON.stringify({ observations }, null, 2));
    return;
  }

  // Worker path — proxy the legacy full-context render.
  const project = projectOverride ?? '';
  const workerPort = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
  const qs = project ? `projects=${encodeURIComponent(project)}&full=true` : 'full=true';
  const url = `http://127.0.0.1:${workerPort}/api/context/inject?${qs}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(`Timeline fetch failed: ${message}`));
    console.error(`Is the worker running? ${pc.bold('npx @bjlee2024/claude-mem start')}`);
    process.exit(1);
  }
  if (!response.ok) {
    console.error(pc.red(`Timeline fetch failed: HTTP ${response.status}`));
    process.exit(1);
  }
  console.log(await response.text());
}

export function runTranscriptWatchCommand(): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();

  const transcriptWatcherPath = join(
    marketplaceDirectory(),
    'plugin',
    'scripts',
    'transcript-watcher.cjs',
  );

  if (!existsSync(transcriptWatcherPath)) {
    spawnBunWorkerCommand('transcript', ['watch']);
    return;
  }

  const child = spawnHidden(bunPath, [transcriptWatcherPath, 'watch'], {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    // Sanitize host CLI bleed-through and Anthropic credentials before
    // launching the Bun worker/server/transcript process. Credentials are
    // re-read from ~/.claude-mem/.env at SDK spawn time (#2357 / #2375).
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(pc.red(`Failed to start transcript watcher: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}
