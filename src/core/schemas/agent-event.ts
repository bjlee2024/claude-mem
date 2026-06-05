// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

export const AgentEventSourceTypeSchema = z.enum(['hook', 'worker', 'provider', 'server', 'api']);

export const AgentEventSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  serverSessionId: z.string().min(1).nullable().default(null),
  sourceType: AgentEventSourceTypeSchema,
  eventType: z.string().min(1),
  // #2560 — which platform produced the event (claude-code, opencode, cursor,
  // ...). Persisted on the Postgres agent_events row for plan-09 scoping; the
  // SQLite repo ignores it. Optional and nullable so existing clients are
  // unaffected.
  platformSource: z.string().min(1).nullable().default(null),
  // Stable per-event id supplied by the producer (e.g. the thin client's spool
  // record id). The server derives agent_events.idempotency_key from it so a
  // replayed offline write dedupes deterministically. Optional/nullable; when
  // absent the server falls back to a payload-derived key. Must be declared
  // here or zod strips it before toAgentEventInput() can read it.
  sourceEventId: z.string().min(1).nullable().default(null),
  payload: z.unknown().default({}),
  contentSessionId: z.string().min(1).nullable().default(null),
  memorySessionId: z.string().min(1).nullable().default(null),
  occurredAtEpoch: z.number().int().nonnegative(),
  createdAtEpoch: z.number().int().nonnegative()
});

export const CreateAgentEventSchema = AgentEventSchema.omit({
  id: true,
  createdAtEpoch: true
}).partial({
  serverSessionId: true,
  platformSource: true,
  sourceEventId: true,
  payload: true,
  contentSessionId: true,
  memorySessionId: true
});

export type AgentEventSourceType = z.infer<typeof AgentEventSourceTypeSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type CreateAgentEvent = z.infer<typeof CreateAgentEventSchema>;
