
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';
import { ModeManager } from '../domain/ModeManager.js';
import { getGitUser } from '../../utils/git-user.js';
import type { ContextConfig } from './types.js';

/**
 * Resolves the CLAUDE_MEM_CONTEXT_GIT_USER setting value to an actual filter
 * value. null means "no filter (everyone)".
 *
 * When the setting is `me` but the current git user can't be read, falls
 * back to everyone — emptying the whole context because the author is
 * unknown would be a net loss for the user.
 */
export function resolveGitUserFilter(
  setting: string | undefined,
  readGitUser: () => string | null
): string | null {
  const value = (setting ?? '').trim();
  if (value === '' || value.toLowerCase() === 'all') return null;
  if (value.toLowerCase() === 'me') return readGitUser();
  return value;
}

export function loadContextConfig(): ContextConfig {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

  const mode = ModeManager.getInstance().getActiveMode();
  const observationTypes = new Set(mode.observation_types.map(t => t.id));
  const observationConcepts = new Set(mode.observation_concepts.map(c => c.id));

  return {
    totalObservationCount: parseInt(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10),
    fullObservationCount: parseInt(settings.CLAUDE_MEM_CONTEXT_FULL_COUNT, 10),
    sessionCount: parseInt(settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT, 10),
    showReadTokens: settings.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS === 'true',
    showWorkTokens: settings.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true',
    showSavingsAmount: settings.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT === 'true',
    showSavingsPercent: settings.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT === 'true',
    observationTypes,
    observationConcepts,
    fullObservationField: settings.CLAUDE_MEM_CONTEXT_FULL_FIELD as 'narrative' | 'facts',
    showLastSummary: settings.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true',
    showLastMessage: settings.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true',
    gitUserFilter: resolveGitUserFilter(
      settings.CLAUDE_MEM_CONTEXT_GIT_USER,
      () => getGitUser(process.cwd())
    ),
  };
}
