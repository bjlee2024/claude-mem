// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/enroll — self-service client enrollment. A client presents the
// team-wide join secret (CLAUDE_MEM_SERVER_ENROLL_SECRET) and receives its own
// team-scoped API key, so operators distribute one shared secret instead of
// minting a token per device with `server enroll`. Keys are still per-device
// (label-tagged, audit-logged, individually revocable). Unset secret = route
// disabled (404), preserving the operator-only flow by default.

import type { Application, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import type { RouteHandler } from '../../../services/server/Server.js';
import type { PostgresPool } from '../../../storage/postgres/pool.js';
import { logger } from '../../../utils/logger.js';
import { ENROLL_LABEL_PATTERN } from '../../../services/hooks/enrollment.js';

export type IssueEnrollmentKey = (input: { serverUrl: string; label: string }) => Promise<{ rawKey: string }>;

export interface ServerEnrollRoutesOptions {
  pool: PostgresPool;
  secret: string | null;
  /** Test seam; defaults to createEnrollment under the default team. */
  issueKey?: IssueEnrollmentKey;
}

function secretMatches(presented: string, expected: string): boolean {
  // Hash both sides so timingSafeEqual sees equal-length buffers.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export class ServerEnrollRoutes implements RouteHandler {
  constructor(private readonly options: ServerEnrollRoutesOptions) {}

  setupRoutes(app: Application): void {
    app.post('/v1/enroll', (req: Request, res: Response) => {
      void this.handleEnroll(req, res);
    });
  }

  private async handleEnroll(req: Request, res: Response): Promise<void> {
    const secret = this.options.secret;
    if (!secret) {
      res.status(404).json({ error: 'NotFound', message: 'Self-enrollment is disabled on this server' });
      return;
    }
    const auth = req.get('authorization') ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    if (!presented || !secretMatches(presented, secret)) {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid join secret' });
      return;
    }
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    if (!ENROLL_LABEL_PATTERN.test(label) || label.length > 128) {
      res.status(400).json({ error: 'ValidationError', message: 'label must match [A-Za-z0-9][A-Za-z0-9._@-]* (max 128)' });
      return;
    }
    try {
      const issueKey = this.options.issueKey ?? this.defaultIssueKey;
      const serverUrl = `${req.protocol}://${req.get('host') ?? ''}`;
      const { rawKey } = await issueKey({ serverUrl, label });
      logger.info('SYSTEM', 'Self-enrolled client device', { label });
      res.status(201).json({ key: rawKey });
    } catch (error) {
      logger.error('SYSTEM', 'Self-enrollment failed', { label }, error as Error);
      res.status(500).json({ error: 'InternalError', message: 'Enrollment failed' });
    }
  }

  private readonly defaultIssueKey: IssueEnrollmentKey = async ({ serverUrl, label }) => {
    const { createEnrollment, ensureDefaultTeamId } = await import('../../../npx-cli/commands/server-enroll.js');
    const teamId = await ensureDefaultTeamId(this.options.pool);
    return createEnrollment({ pool: this.options.pool, teamId, serverUrl, label });
  };
}
