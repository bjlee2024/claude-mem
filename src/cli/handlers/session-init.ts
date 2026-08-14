// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { isInternalProtocolPayload } from '../../utils/tag-stripping.js';
import { resolveRuntimeContext, buildClientContext, logServerBetaFallback } from '../../services/hooks/runtime-selector.js';
import { isServerBetaClientError } from '../../services/hooks/server-beta-client.js';
import { makeSpoolSender } from '../../services/hooks/spool-flush.js';
import { getGitUser } from '../../utils/git-user.js';
import { isSessionPaused } from '../../shared/session-pause.js';

interface SessionInitResponse {
  sessionDbId: number;
  promptNumber: number;
  skipped?: boolean;
  reason?: string;
  contextInjected?: boolean;
}

interface SemanticContextResponse {
  context: string;
  count: number;
}

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, prompt: rawPrompt } = input;
    const cwd = input.cwd ?? process.cwd();  

    if (!sessionId) {
      logger.warn('HOOK', 'session-init: No sessionId provided, skipping (Codex CLI or unknown platform)');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (!shouldTrackProject(cwd)) {
      logger.info('HOOK', 'Project excluded from tracking', { cwd });
      return { continue: true, suppressOutput: true };
    }

    if (rawPrompt && isInternalProtocolPayload(rawPrompt)) {
      logger.debug('HOOK', 'session-init: skipping internal protocol payload', {
        preview: rawPrompt.slice(0, 80),
      });
      return { continue: true, suppressOutput: true };
    }

    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;

    const project = getProjectContext(cwd).primary;
    const gitUser = getGitUser(cwd);
    const platformSource = normalizePlatformSource(input.platform);

    const runtime = resolveRuntimeContext();
    if (runtime.runtime === 'client') {
      const { client, resolver, spool, fixedProjectId } = buildClientContext(runtime);
      try { await spool.flush(makeSpoolSender({ client })); } catch { /* best-effort */ }
      let projectId: string | undefined;
      try {
        projectId = fixedProjectId ?? await resolver.resolve(cwd);
        await client.startSession({
          projectId,
          externalSessionId: sessionId,
          contentSessionId: sessionId,
          agentId: input.agentId ?? null,
          agentType: input.agentType ?? null,
          platformSource,
          metadata: { project, prompt, gitUser },
        });
      } catch (error) {
        logger.error('HOOK', 'client startSession failed (best-effort)', { error: String(error) });
      }
      // Prompt text is a separate event so every prompt is captured — the
      // session row only holds the first one, because startSession returns
      // early for an existing session. generate:false keeps this from
      // queueing an observation-generation job.
      if (projectId && !isSessionPaused(sessionId)) {
        try {
          await client.recordEvent({
            projectId,
            contentSessionId: sessionId,
            sourceType: 'hook',
            eventType: 'user_prompt',
            occurredAtEpoch: Date.now(),
            payload: { prompt },
            generate: false,
          });
        } catch (error) {
          logger.error('HOOK', 'client user_prompt event failed (best-effort)', { error: String(error) });
        }
      }
      const pending = logger.drainForwardBuffer();
      if (pending.length) { await client.forwardLogs(pending); }
      return { continue: true, suppressOutput: true };
    }
    if (runtime.runtime === 'server-beta') {
      try {
        await runtime.client.startSession({
          projectId: runtime.projectId,
          externalSessionId: sessionId,
          contentSessionId: sessionId,
          agentId: input.agentId ?? null,
          agentType: input.agentType ?? null,
          platformSource,
          metadata: { project, prompt, gitUser },
        });
        logger.info('HOOK', 'session-init: server-beta session started', {
          contentSessionId: sessionId,
          project,
        });
        // Prompt text is a separate event so every prompt is captured — the
        // session row only holds the first one, because startSession returns
        // early for an existing session. generate:false keeps this from
        // queueing an observation-generation job.
        if (!isSessionPaused(sessionId)) {
          try {
            await runtime.client.recordEvent({
              projectId: runtime.projectId,
              contentSessionId: sessionId,
              sourceType: 'hook',
              eventType: 'user_prompt',
              occurredAtEpoch: Date.now(),
              payload: { prompt },
              generate: false,
            });
          } catch (error) {
            logger.error('HOOK', 'server-beta user_prompt event failed (best-effort)', { error: String(error) });
          }
        }
        // Server-beta does not currently support the same context-injection
        // protocol as the worker. Skip semantic injection in server-beta mode
        // until the server-beta context endpoint exists.
        return { continue: true, suppressOutput: true };
      } catch (error: unknown) {
        if (isServerBetaClientError(error) && error.isFallbackEligible()) {
          logServerBetaFallback(error.kind, {
            status: error.status,
            message: error.message,
            route: '/v1/sessions/start',
          });
          // fall through to worker fallback
        } else {
          logger.error('HOOK', 'Server beta session-start failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
    }

    logger.debug('HOOK', 'session-init: Calling /api/sessions/init', { contentSessionId: sessionId, project });

    const initResult = await executeWithWorkerFallback<SessionInitResponse>(
      '/api/sessions/init',
      'POST',
      {
        contentSessionId: sessionId,
        project,
        prompt,
        platformSource,
        gitUser,
      },
    );

    if (isWorkerFallback(initResult)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (typeof initResult?.sessionDbId !== 'number') {
      logger.failure('HOOK', 'Session initialization returned malformed response', { contentSessionId: sessionId, project });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const sessionDbId = initResult.sessionDbId;
    const promptNumber = initResult.promptNumber;

    logger.debug('HOOK', 'session-init: Received from /api/sessions/init', { sessionDbId, promptNumber, skipped: initResult.skipped, contextInjected: initResult.contextInjected });

    logger.debug('HOOK', `[ALIGNMENT] Hook Entry | contentSessionId=${sessionId} | prompt#=${promptNumber} | sessionDbId=${sessionDbId}`);

    if (initResult.skipped && initResult.reason === 'private') {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=private`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }

    const settings = loadFromFileOnce();
    const semanticInject =
      String(settings.CLAUDE_MEM_SEMANTIC_INJECT).toLowerCase() === 'true';
    let additionalContext = '';

    if (semanticInject && prompt && prompt.length >= 20 && prompt !== '[media prompt]') {
      const limit = settings.CLAUDE_MEM_SEMANTIC_INJECT_LIMIT || '5';
      const semanticResult = await executeWithWorkerFallback<SemanticContextResponse>(
        '/api/context/semantic',
        'POST',
        { q: prompt, project, limit },
      );
      if (!isWorkerFallback(semanticResult) && semanticResult?.context) {
        logger.debug('HOOK', `Semantic injection: ${semanticResult.count} observations for prompt`, { sessionId: sessionDbId, count: semanticResult.count });
        additionalContext = semanticResult.context;
      }
    }

    logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | project=${project}`, {
      sessionId: sessionDbId
    });

    if (additionalContext) {
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext
        }
      };
    }

    return { continue: true, suppressOutput: true };
  }
};
