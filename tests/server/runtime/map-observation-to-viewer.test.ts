// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { mapObservationToViewer } from '../../../src/server/runtime/ServerViewerDataRoutes.js';

describe('mapObservationToViewer', () => {
  const baseRow = {
    id: 'obs-uuid-1',
    server_session_id: 'sess-1',
    project_name: 'claude-mem',
    kind: 'observation',
    content: 'the narrative text',
    metadata: {
      title: 'Title', subtitle: 'Sub', narrative: 'N',
      facts: ['a', 'b'], concepts: ['c'],
      files_read: ['/x'], files_modified: [],
      provider: 'claude',
    },
    created_at: new Date('2026-06-04T00:00:00.000Z'),
  };

  it('maps structured metadata into JSON-stringified array fields', () => {
    const v = mapObservationToViewer(baseRow);
    expect(v.id).toBe('obs-uuid-1');
    expect(v.memory_session_id).toBe('sess-1');
    expect(v.project).toBe('claude-mem');
    expect(v.type).toBe('observation');
    expect(v.text).toBe('the narrative text');
    expect(v.title).toBe('Title');
    expect(v.facts).toBe('["a","b"]');
    expect(v.concepts).toBe('["c"]');
    expect(v.files_read).toBe('["/x"]');
    expect(v.files_modified).toBe('[]');
    expect(v.platform_source).toBe('claude');
    expect(v.created_at).toBe('2026-06-04T00:00:00.000Z');
    expect(v.created_at_epoch).toBe(Date.parse('2026-06-04T00:00:00.000Z'));
    expect(v.merged_into_project).toBeNull();
    expect(v.prompt_number).toBeNull();
  });

  it('prefers session platform_source over generation provider', () => {
    const v = mapObservationToViewer({
      ...baseRow,
      session_platform_source: 'grok',
      metadata: { ...baseRow.metadata, provider: 'openrouter' },
    });
    expect(v.platform_source).toBe('grok');
  });

  it('ignores non-agent provider labels when no session source is present', () => {
    const v = mapObservationToViewer({
      ...baseRow,
      session_platform_source: null,
      metadata: { provider: 'openrouter' },
    });
    expect(v.platform_source).toBe('claude');
  });

  it('handles missing metadata fields and null session/project as safe defaults', () => {
    const v = mapObservationToViewer({
      id: 'o2', server_session_id: null, project_name: null,
      kind: 'observation', content: 'c', metadata: {}, created_at: new Date('2026-06-04T00:00:00.000Z'),
    });
    expect(v.memory_session_id).toBe('');
    expect(v.project).toBe('');
    expect(v.platform_source).toBe('claude');
    expect(v.title).toBeNull();
    expect(v.facts).toBeNull();
  });
});
