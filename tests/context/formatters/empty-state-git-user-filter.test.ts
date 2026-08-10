import { describe, it, expect } from 'bun:test';
import { renderHumanEmptyState } from '../../../src/services/context/formatters/HumanFormatter.js';
import { renderAgentEmptyState } from '../../../src/services/context/formatters/AgentFormatter.js';

// Finding 1: the empty-state path used to drop the git-user filter note,
// making "no history at all" indistinguishable from "the filter hid
// everything" — exactly the case the header note exists to disambiguate.

describe('renderHumanEmptyState — git user filter note', () => {
  it('shows no filter note when no filter is active (default "all")', () => {
    const result = renderHumanEmptyState('my-project', null);
    expect(result).not.toContain('filtered to');
  });

  it('shows a filter note when a filter is active, so "no history" and "filtered out" are distinguishable', () => {
    const result = renderHumanEmptyState('my-project', 'bjlee2024');
    expect(result).toContain('filtered to bjlee2024');
  });
});

describe('renderAgentEmptyState — git user filter note', () => {
  it('shows no filter note when no filter is active (default "all")', () => {
    const result = renderAgentEmptyState('my-project', null);
    expect(result).not.toContain('filtered to');
  });

  it('shows a filter note when a filter is active, so the agent knows its own setting caused the empty result', () => {
    const result = renderAgentEmptyState('my-project', 'bjlee2024');
    expect(result).toContain('filtered to bjlee2024');
  });
});
