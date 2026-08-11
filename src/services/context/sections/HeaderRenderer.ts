
import type { ContextConfig, TokenEconomics } from '../types.js';
import { shouldShowContextEconomics } from '../TokenCalculator.js';
import * as Agent from '../formatters/AgentFormatter.js';
import * as Human from '../formatters/HumanFormatter.js';

export function renderHeader(
  project: string,
  economics: TokenEconomics,
  config: ContextConfig,
  forHuman: boolean,
  // The filter actually applied to the observations shown, or null. Passed
  // explicitly by the caller rather than read from config.gitUserFilter —
  // config reflects the local setting, which is not always what actually
  // ran (see ContextBuilder.ts's appliedGitUserFilter comment).
  gitUserFilter: string | null = null
): string[] {
  const output: string[] = [];

  if (forHuman) {
    output.push(...Human.renderHumanHeader(project, gitUserFilter));
  } else {
    output.push(...Agent.renderAgentHeader(project));
  }

  if (forHuman) {
    output.push(...Human.renderHumanLegend());
  } else {
    output.push(...Agent.renderAgentLegend());
  }

  if (forHuman) {
    output.push(...Human.renderHumanColumnKey());
  } else {
    output.push(...Agent.renderAgentColumnKey());
  }

  if (forHuman) {
    output.push(...Human.renderHumanContextIndex());
  } else {
    output.push(...Agent.renderAgentContextIndex());
  }

  if (shouldShowContextEconomics(config)) {
    if (forHuman) {
      output.push(...Human.renderHumanContextEconomics(economics, config));
    } else {
      output.push(...Agent.renderAgentContextEconomics(economics, config));
    }
  }

  return output;
}
