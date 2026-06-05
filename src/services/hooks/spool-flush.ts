// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — replays a spooled record as a server write. projectName
// is resolved at flush time (the UUID may not have existed when enqueued
// offline). Errors: eligible -> retry; anything else (incl. 4xx) -> permanent drop.
import type { ServerBetaClient } from './server-beta-client.js';
import { isServerBetaClientError } from './server-beta-client.js';
import type { SpoolRecord, SpoolSendResult } from './spool.js';

export interface SpoolSenderDeps { client: Pick<ServerBetaClient, 'resolveProject' | 'recordEvent'> }

export function makeSpoolSender(deps: SpoolSenderDeps): (r: SpoolRecord) => Promise<SpoolSendResult> {
  return async (r: SpoolRecord): Promise<SpoolSendResult> => {
    try {
      const projectId = await deps.client.resolveProject(r.projectName);
      const body = (r.body ?? {}) as Record<string, unknown>;
      await deps.client.recordEvent({
        projectId,
        contentSessionId: (body.contentSessionId as string | undefined) ?? null,
        sourceType: 'hook',
        eventType: (body.eventType as string) ?? 'tool_use',
        occurredAtEpoch: (body.occurredAtEpoch as number) ?? Date.now(),
        sourceEventId: (body.sourceEventId as string) ?? r.id,
        payload: body.payload,
      });
      return { ok: true };
    } catch (error) {
      if (isServerBetaClientError(error) && error.isFallbackEligible()) return { ok: false, permanent: false };
      return { ok: false, permanent: true };
    }
  };
}
