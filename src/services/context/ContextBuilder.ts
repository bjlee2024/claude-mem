
import path from 'path';
import { homedir } from 'os';
import { unlinkSync } from 'fs';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { ModeManager } from '../domain/ModeManager.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';

import type { ContextInput, ContextConfig, Observation, SessionSummary } from './types.js';
import { loadContextConfig } from './ContextConfigLoader.js';
import { calculateTokenEconomics } from './TokenCalculator.js';
import {
  queryObservations,
  queryObservationsMulti,
  querySummaries,
  querySummariesMulti,
  getPriorSessionMessages,
  prepareSummariesForTimeline,
  buildTimeline,
  getFullObservationIds,
} from './ObservationCompiler.js';
import { renderHeader } from './sections/HeaderRenderer.js';
import { renderTimeline } from './sections/TimelineRenderer.js';
import { shouldShowSummary, renderSummaryFields } from './sections/SummaryRenderer.js';
import { renderPreviouslySection, renderFooter } from './sections/FooterRenderer.js';
import { renderAgentEmptyState } from './formatters/AgentFormatter.js';
import { renderHumanEmptyState } from './formatters/HumanFormatter.js';

const VERSION_MARKER_PATH = path.join(
  homedir(),
  '.claude',
  'plugins',
  'marketplaces',
  'bjlee2024',
  'plugin',
  '.install-version'
);

function initializeDatabase(): SessionStore | null {
  try {
    return new SessionStore();
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_DLOPEN_FAILED') {
      try {
        unlinkSync(VERSION_MARKER_PATH);
      } catch (unlinkError) {
        if (unlinkError instanceof Error) {
          logger.debug('WORKER', 'Marker file cleanup failed (may not exist)', {}, unlinkError);
        } else {
          logger.debug('WORKER', 'Marker file cleanup failed (may not exist)', { error: String(unlinkError) });
        }
      }
      logger.error('WORKER', 'Native module rebuild needed - restart Claude Code to auto-fix');
      return null;
    }
    throw error;
  }
}

function renderEmptyState(project: string, forHuman: boolean, gitUserFilter: string | null): string {
  return forHuman ? renderHumanEmptyState(project, gitUserFilter) : renderAgentEmptyState(project, gitUserFilter);
}

function buildContextOutput(
  project: string,
  observations: Observation[],
  summaries: SessionSummary[],
  config: ContextConfig,
  cwd: string,
  sessionId: string | undefined,
  forHuman: boolean,
  // The filter actually applied to the observations being rendered — NOT
  // necessarily config.gitUserFilter. The worker path (generateContext)
  // filters in SQL, so its config.gitUserFilter reflects reality. The
  // client/server-beta path (renderContextFromObservations) fetches rows
  // over the network with no author filter, so it must pass null here even
  // if CLAUDE_MEM_CONTEXT_GIT_USER is set locally — otherwise the header
  // would claim a filter that never ran. Callers decide; the renderer never
  // guesses from config.
  appliedGitUserFilter: string | null
): string {
  const output: string[] = [];

  const economics = calculateTokenEconomics(observations);

  output.push(...renderHeader(project, economics, config, forHuman, appliedGitUserFilter));

  const displaySummaries = summaries.slice(0, config.sessionCount);
  const summariesForTimeline = prepareSummariesForTimeline(displaySummaries, summaries);
  const timeline = buildTimeline(observations, summariesForTimeline);
  const fullObservationIds = getFullObservationIds(observations, config.fullObservationCount);

  output.push(...renderTimeline(timeline, fullObservationIds, config, cwd, forHuman));

  const mostRecentSummary = summaries[0];
  const mostRecentObservation = observations[0];

  if (shouldShowSummary(config, mostRecentSummary, mostRecentObservation)) {
    output.push(...renderSummaryFields(mostRecentSummary, forHuman));
  }

  const priorMessages = getPriorSessionMessages(observations, config, sessionId, cwd);
  output.push(...renderPreviouslySection(priorMessages, forHuman));

  output.push(...renderFooter(economics, config, forHuman));

  return output.join('\n').trimEnd();
}

/**
 * Pure renderer — takes already-fetched observations (no DB access) and
 * returns the same formatted output that generateContext() produces for the
 * worker path. Used by the client-mode context handler so both paths share
 * identical formatting.
 *
 * @param project   Repo/project name shown in the header.
 * @param observations  Observations already mapped to the canonical shape.
 * @param cwd       Working directory (used for relative-path rendering).
 * @param forHuman  true → terminal-friendly with ANSI colours; false → agent text.
 */
export function renderContextFromObservations(
  project: string,
  observations: Observation[],
  cwd: string,
  forHuman: boolean,
  summaries: SessionSummary[] = [],
  sessionId?: string,
): string {
  if (observations.length === 0 && summaries.length === 0) return '';
  // The worker loads the active mode at startup; the client hook path does not,
  // so loadContextConfig() → ModeManager.getActiveMode() throws "No mode loaded".
  // Load it on demand (idempotent — only when no mode is active yet).
  try {
    ModeManager.getInstance().getActiveMode();
  } catch {
    ModeManager.getInstance().loadMode(loadFromFileOnce().CLAUDE_MEM_MODE || 'code');
  }
  // appliedGitUserFilter is hard-coded null: this path fetches observations
  // remotely via client.contextObservations(...), which applies no author
  // filter server-side. Passing loadContextConfig().gitUserFilter here would
  // make the header claim filtering that never happened.
  return buildContextOutput(
    project,
    observations,
    summaries,
    loadContextConfig(),
    cwd,
    sessionId,
    forHuman,
    null,
  );
}

export async function generateContext(
  input?: ContextInput,
  forHuman: boolean = false
): Promise<string> {
  const config = loadContextConfig();
  const cwd = input?.cwd ?? process.cwd();
  const context = getProjectContext(cwd);

  const projects = input?.projects?.length ? input.projects : context.allProjects;
  const project = projects[projects.length - 1] ?? context.primary;

  if (input?.full) {
    config.totalObservationCount = 999999;
    config.sessionCount = 999999;
  }

  const db = initializeDatabase();
  if (!db) {
    return '';
  }

  try {
    const observations = projects.length > 1
      ? queryObservationsMulti(db, projects, config)
      : queryObservations(db, project, config);
    const summaries = projects.length > 1
      ? querySummariesMulti(db, projects, config)
      : querySummaries(db, project, config);

    if (observations.length === 0 && summaries.length === 0) {
      return renderEmptyState(project, forHuman, config.gitUserFilter);
    }

    // This path filtered in SQL (see ObservationCompiler), so config.gitUserFilter
    // reflects what was actually applied — safe to pass straight through.
    const output = buildContextOutput(
      project,
      observations,
      summaries,
      config,
      cwd,
      input?.session_id,
      forHuman,
      config.gitUserFilter
    );

    return output;
  } finally {
    db.close();
  }
}
