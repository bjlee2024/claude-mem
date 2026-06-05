// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — single funnel for thin-client writes. Resolves the
// per-repo project, sends to the server, spools on eligible failure. The spool
// record id is reused as the event sourceEventId so server-side idempotency
// (agent_events.idempotency_key) absorbs replays. NEVER throws into a hook.
import type { ServerBetaClient } from './server-beta-client.js';
import { isServerBetaClientError } from './server-beta-client.js';
import { ProjectResolver } from './project-resolver.js';
import type { Spool, SpoolRecord } from './spool.js';
import { logger } from '../../utils/logger.js';

export interface ClientWriterOptions {
  client: Pick<ServerBetaClient, 'recordEvent'>;
  resolver: { resolve(cwd: string): Promise<string> };
  spool: Spool;
  fixedProjectId?: string | null;
}

export interface RecordToolUseInput {
  cwd: string;
  sessionId: string;
  sourceEventId: string;
  payload: unknown;
}

export class ClientWriter {
  constructor(private readonly o: ClientWriterOptions) {}

  private async projectId(cwd: string): Promise<string> {
    return this.o.fixedProjectId ?? this.o.resolver.resolve(cwd);
  }

  async recordToolUse(input: RecordToolUseInput): Promise<void> {
    let projectId: string;
    try {
      projectId = await this.projectId(input.cwd);
    } catch {
      this.spoolEvent(input);
      return;
    }
    try {
      await this.o.client.recordEvent({
        projectId,
        contentSessionId: input.sessionId,
        sourceType: 'hook',
        eventType: 'tool_use',
        occurredAtEpoch: Date.now(),
        sourceEventId: input.sourceEventId,
        payload: input.payload,
      });
    } catch (error) {
      if (isServerBetaClientError(error) && error.isFallbackEligible()) {
        this.spoolEvent(input);
      } else {
        logger.error('HOOK', 'client write permanent failure', { error: String(error) });
      }
    }
  }

  private spoolEvent(input: RecordToolUseInput): void {
    const record: SpoolRecord = {
      id: input.sourceEventId,
      kind: 'event',
      endpoint: '/v1/events',
      body: {
        contentSessionId: input.sessionId,
        sourceType: 'hook',
        eventType: 'tool_use',
        occurredAtEpoch: Date.now(),
        sourceEventId: input.sourceEventId,
        payload: input.payload,
      },
      projectName: ProjectResolver.projectName(input.cwd),
      enqueuedAtEpoch: Date.now(),
    };
    this.o.spool.append(record);
  }
}
