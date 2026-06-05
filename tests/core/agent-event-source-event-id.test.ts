// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — the thin client sends a stable `sourceEventId` (its spool
// record id) so a replayed offline write derives the same agent_events
// idempotency_key and dedupes. That only works if the field SURVIVES zod
// parsing (zod strips unknown keys by default). These tests lock that in.
import { describe, expect, it } from 'bun:test';
import { CreateAgentEventSchema } from '../../src/core/schemas/agent-event.js';

describe('CreateAgentEventSchema sourceEventId', () => {
  const base = { projectId: 'p', sourceType: 'hook' as const, eventType: 'tool_use', occurredAtEpoch: 1 };

  it('preserves a supplied sourceEventId through parse', () => {
    const parsed = CreateAgentEventSchema.parse({ ...base, sourceEventId: 'evt-1' });
    expect(parsed.sourceEventId).toBe('evt-1');
  });

  it('defaults sourceEventId to null when absent', () => {
    const parsed = CreateAgentEventSchema.parse({ ...base });
    expect(parsed.sourceEventId).toBeNull();
  });
});
