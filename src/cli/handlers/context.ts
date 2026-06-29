// IO discipline (see src/shared/hook-io.ts):
// - hookSpecificOutput.additionalContext → MODEL_CONTEXT (model consumes; via stdout JSON)
// - systemMessage                        → USER_HINT (user-visible; via stdout JSON systemMessage)
// This handler is PURE: it returns a HookResult and MUST NOT call
// process.stderr.write / process.stdout.write / console.* / process.exit.
// logger.* calls are DIAGNOSTIC and route through hook-io's stderr path.
import path from 'path';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import {
  executeWithWorkerFallback,
  isWorkerFallback,
  getWorkerPort,
} from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { readStaleMarker } from '../../shared/oauth-token.js';
import { resolveRuntimeContext, buildClientContext } from '../../services/hooks/runtime-selector.js';
import { makeSpoolSender } from '../../services/hooks/spool-flush.js';
import { renderContextFromObservations } from '../../services/context/ContextBuilder.js';
import { ProjectResolver } from '../../services/hooks/project-resolver.js';
import type { Observation, SessionSummary } from '../../services/context/types.js';

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const cwd = input.cwd ?? process.cwd();

    const runtime = resolveRuntimeContext();
    if (runtime.runtime === 'client') {
      const { client, resolver, spool, fixedProjectId } = buildClientContext(runtime);
      try { await spool.flush(makeSpoolSender({ client })); } catch { /* best-effort */ }
      const emptyResult: HookResult = {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
        exitCode: HOOK_EXIT_CODES.SUCCESS,
      };
      try {
        const projectId = fixedProjectId ?? await resolver.resolve(cwd);
        const ctx = await client.contextObservations({ projectId, query: '', limit: 10 });

        // Derive a human-readable project name for the formatter header.
        const projectName = ProjectResolver.projectName(cwd) || path.basename(cwd);

        // Map server-beta rows to the canonical shapes that buildContextOutput /
        // renderContextFromObservations expect. Summary rows (kind='summary')
        // become SessionSummary entries so the summary panel renders; everything
        // else becomes an Observation for the timeline.
        const observations: Observation[] = [];
        const summaries: SessionSummary[] = [];

        (ctx.observations ?? []).forEach((obs, idx) => {
          const o = obs as Record<string, unknown>;
          const meta = (obs.metadata && typeof obs.metadata === 'object')
            ? (obs.metadata as Record<string, unknown>)
            : {};

          // Timestamp: the server emits `createdAtEpoch` (epoch ms). Fall back to
          // a metadata ISO string, else 0. (Reading the wrong field is what caused
          // every observation to render as "Jan 1, 1970".)
          const created_at_epoch =
            typeof o.createdAtEpoch === 'number' ? o.createdAtEpoch :
            typeof meta.created_at === 'string' ? (Date.parse(meta.created_at) || 0) :
            typeof o.created_at === 'string' ? (Date.parse(String(o.created_at)) || 0) :
            0;
          const rawCreatedAt = new Date(created_at_epoch).toISOString();

          const memorySessionId = typeof o.serverSessionId === 'string' ? o.serverSessionId : '';
          const kind = typeof meta.type === 'string' ? meta.type
            : typeof o.kind === 'string' ? String(o.kind)
            : 'observation';

          const asStr = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

          if (kind === 'summary') {
            summaries.push({
              id: idx,
              memory_session_id: memorySessionId,
              platform_source: typeof meta.provider === 'string' ? meta.provider : undefined,
              request: asStr(meta.request),
              investigated: asStr(meta.investigated),
              learned: asStr(meta.learned),
              completed: asStr(meta.completed),
              next_steps: asStr(meta.next_steps),
              created_at: rawCreatedAt,
              created_at_epoch,
              project: projectName,
            } satisfies SessionSummary);
            return;
          }

          // facts / concepts / files are stored as arrays in metadata; the
          // Observation type carries them as JSON strings (or null).
          const asJsonStr = (v: unknown): string | null =>
            Array.isArray(v) ? JSON.stringify(v) : typeof v === 'string' ? v : null;

          observations.push({
            id: idx,
            memory_session_id: memorySessionId,
            platform_source: typeof meta.provider === 'string' ? meta.provider : undefined,
            type: kind,
            title: typeof meta.title === 'string' ? meta.title : null,
            subtitle: typeof meta.subtitle === 'string' ? meta.subtitle : null,
            narrative: typeof meta.narrative === 'string' ? meta.narrative
              : typeof o.content === 'string' ? String(o.content)
              : null,
            facts: asJsonStr(meta.facts),
            concepts: asJsonStr(meta.concepts),
            files_read: asJsonStr(meta.files_read),
            files_modified: asJsonStr(meta.files_modified),
            discovery_tokens: null,
            created_at: rawCreatedAt,
            created_at_epoch,
            project: projectName,
          } satisfies Observation);
        });

        const showTerminalOutput = loadFromFileOnce().CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true';

        // additionalContext → model (agent format, no ANSI colours)
        const additionalContext = renderContextFromObservations(projectName, observations, cwd, false, summaries);

        // systemMessage → user-visible terminal output (human format with colours)
        const systemMessage = showTerminalOutput && additionalContext
          ? renderContextFromObservations(projectName, observations, cwd, true, summaries)
          : undefined;

        const pending = logger.drainForwardBuffer();
        if (pending.length) { void client.forwardLogs(pending); }
        return {
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
          ...(systemMessage !== undefined ? { systemMessage } : {}),
          exitCode: HOOK_EXIT_CODES.SUCCESS,
        };
      } catch {
        const pending = logger.drainForwardBuffer();
        if (pending.length) { void client.forwardLogs(pending); }
        return emptyResult;
      }
    }

    const context = getProjectContext(cwd);
    const port = getWorkerPort();

    const settings = loadFromFileOnce();
    const showTerminalOutput = settings.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true';

    const projectsParam = context.allProjects.join(',');
    const apiPath = `/api/context/inject?projects=${encodeURIComponent(projectsParam)}`;
    const colorApiPath = input.platform === 'claude-code' ? `${apiPath}&colors=true` : apiPath;

    const emptyResult: HookResult = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      exitCode: HOOK_EXIT_CODES.SUCCESS,
    };

    const contextResult = await executeWithWorkerFallback<string>(apiPath, 'GET');
    if (isWorkerFallback(contextResult)) {
      return emptyResult;
    }

    let additionalContext: string;
    if (typeof contextResult === 'string') {
      additionalContext = contextResult.trim();
    } else if (contextResult === undefined) {
      additionalContext = '';
    } else {
      logger.warn('HOOK', 'Context response was not a string', { type: typeof contextResult });
      return emptyResult;
    }

    // Issue #2215: surface stale OAuth token marker as a session-start hint.
    // Marker is written by EnvManager.buildIsolatedEnvWithFreshOAuth() when
    // a previous worker spawn detected an expired keychain entry.
    const staleReason = readStaleMarker();
    if (staleReason) {
      const hint = `[claude-mem] Claude Desktop OAuth token is stale: ${staleReason}\nPlease re-login via Claude Desktop to refresh the token.`;
      additionalContext = additionalContext
        ? `${hint}\n\n${additionalContext}`
        : hint;
    }

    let coloredTimeline = '';
    if (showTerminalOutput) {
      const colorResult = await executeWithWorkerFallback<string>(colorApiPath, 'GET');
      if (!isWorkerFallback(colorResult) && typeof colorResult === 'string') {
        coloredTimeline = colorResult.trim();
      }
    }

    const platform = input.platform;

    const displayContent = coloredTimeline || (platform === 'gemini-cli' || platform === 'gemini' ? additionalContext : '');

    const systemMessage = showTerminalOutput && displayContent
      ? `${displayContent}\n\nView Observations Live @ http://localhost:${port}`
      : undefined;

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext
      },
      systemMessage
    };
  }
};
