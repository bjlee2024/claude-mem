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
import type { Observation } from '../../services/context/types.js';

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

        // Map server-beta observations to the canonical Observation shape that
        // buildContextOutput / renderContextFromObservations expects.
        const observations: Observation[] = (ctx.observations ?? []).map((obs, idx) => {
          const meta = (obs.metadata && typeof obs.metadata === 'object')
            ? (obs.metadata as Record<string, unknown>)
            : {};

          // created_at: prefer metadata timestamp, fall back to top-level field.
          const rawCreatedAt: string =
            typeof meta.created_at === 'string' ? meta.created_at :
            typeof (obs as Record<string, unknown>).created_at === 'string' ? String((obs as Record<string, unknown>).created_at) :
            new Date(0).toISOString();

          // created_at_epoch: derive from the ISO string so we never call bare Date.now().
          const created_at_epoch = Date.parse(rawCreatedAt) || 0;

          // facts / concepts are stored as arrays in metadata; the Observation
          // type carries them as JSON strings (or null).
          const factsRaw = meta.facts;
          const factsStr: string | null = Array.isArray(factsRaw)
            ? JSON.stringify(factsRaw)
            : typeof factsRaw === 'string' ? factsRaw : null;

          const conceptsRaw = meta.concepts;
          const conceptsStr: string | null = Array.isArray(conceptsRaw)
            ? JSON.stringify(conceptsRaw)
            : typeof conceptsRaw === 'string' ? conceptsRaw : null;

          const filesReadRaw = meta.files_read;
          const filesReadStr: string | null = Array.isArray(filesReadRaw)
            ? JSON.stringify(filesReadRaw)
            : typeof filesReadRaw === 'string' ? filesReadRaw : null;

          const filesModifiedRaw = meta.files_modified;
          const filesModifiedStr: string | null = Array.isArray(filesModifiedRaw)
            ? JSON.stringify(filesModifiedRaw)
            : typeof filesModifiedRaw === 'string' ? filesModifiedRaw : null;

          return {
            id: idx,
            memory_session_id: typeof (obs as Record<string, unknown>).serverSessionId === 'string'
              ? String((obs as Record<string, unknown>).serverSessionId)
              : '',
            platform_source: typeof meta.provider === 'string' ? meta.provider : undefined,
            type: typeof meta.type === 'string' ? meta.type
              : typeof (obs as Record<string, unknown>).kind === 'string' ? String((obs as Record<string, unknown>).kind)
              : 'observation',
            title: typeof meta.title === 'string' ? meta.title : null,
            subtitle: typeof meta.subtitle === 'string' ? meta.subtitle : null,
            narrative: typeof meta.narrative === 'string' ? meta.narrative
              : typeof (obs as Record<string, unknown>).content === 'string' ? String((obs as Record<string, unknown>).content)
              : null,
            facts: factsStr,
            concepts: conceptsStr,
            files_read: filesReadStr,
            files_modified: filesModifiedStr,
            discovery_tokens: null,
            created_at: rawCreatedAt,
            created_at_epoch,
            project: projectName,
          } satisfies Observation;
        });

        const showTerminalOutput = loadFromFileOnce().CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true';

        // additionalContext → model (agent format, no ANSI colours)
        const additionalContext = renderContextFromObservations(projectName, observations, cwd, false);

        // systemMessage → user-visible terminal output (human format with colours)
        const systemMessage = showTerminalOutput && additionalContext
          ? renderContextFromObservations(projectName, observations, cwd, true)
          : undefined;

        return {
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
          ...(systemMessage !== undefined ? { systemMessage } : {}),
          exitCode: HOOK_EXIT_CODES.SUCCESS,
        };
      } catch {
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
