// SPDX-License-Identifier: Apache-2.0
//
// Viewer data API for the server-beta runtime. The bundled viewer
// (viewer-bundle.js) fetches /api/observations, /api/summaries, /api/stats,
// /api/projects, /api/processing-status, /api/prompts, /api/settings and opens
// an EventSource on /stream. Those endpoints exist only in the legacy worker
// runtime (DataRoutes.ts, SQLite). server-beta serves the static viewer but
// never implemented its read API, so the viewer was stuck on "Loading more...".
// This handler implements the read-only subset, backed by Postgres, with NO
// auth (the viewer's authFetch sends no credentials; deployment is a trusted
// tailnet). Read-only: no writes, no team/tenant scoping (single-owner server).

import type { Application, Request, Response } from 'express';
import type { RouteHandler } from '../../services/server/Server.js';
import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import { logger } from '../../utils/logger.js';

export interface ViewerObservation {
  id: string;
  memory_session_id: string;
  project: string;
  merged_into_project: string | null;
  platform_source: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

export interface ViewerObservationRow {
  id: string;
  server_session_id: string | null;
  project_name: string | null;
  kind: string;
  content: string;
  metadata: unknown;
  created_at: Date | string;
}

function asStringArrayJson(value: unknown): string | null {
  if (Array.isArray(value)) return JSON.stringify(value);
  return null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function mapObservationToViewer(row: ViewerObservationRow): ViewerObservation {
  const meta = row.metadata && typeof row.metadata === 'object'
    ? (row.metadata as Record<string, unknown>)
    : {};
  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  return {
    id: row.id,
    memory_session_id: row.server_session_id ?? '',
    project: row.project_name ?? '',
    merged_into_project: null,
    platform_source: typeof meta.provider === 'string' ? meta.provider : 'claude',
    type: row.kind,
    title: asStringOrNull(meta.title),
    subtitle: asStringOrNull(meta.subtitle),
    narrative: asStringOrNull(meta.narrative),
    text: row.content,
    facts: asStringArrayJson(meta.facts),
    concepts: asStringArrayJson(meta.concepts),
    files_read: asStringArrayJson(meta.files_read),
    files_modified: asStringArrayJson(meta.files_modified),
    prompt_number: null,
    created_at: createdAt.toISOString(),
    created_at_epoch: createdAt.getTime(),
  };
}

export function parsePagination(req: Request): { offset: number; limit: number; project?: string } {
  const offsetRaw = Number.parseInt(String(req.query.offset ?? ''), 10);
  const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  let limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 50;
  if (limit > 200) limit = 200;
  const project = typeof req.query.project === 'string' && req.query.project.length > 0
    ? req.query.project
    : undefined;
  return { offset, limit, project };
}

interface CountRow { count: string }

export class ServerViewerDataRoutes implements RouteHandler {
  constructor(private readonly pool: PostgresQueryable) {}

  setupRoutes(app: Application): void {
    app.get('/api/observations', (req, res) => this.handleObservations(req, res, false));
    app.get('/api/summaries', (req, res) => this.handleObservations(req, res, true));
    app.get('/api/prompts', (req, res) => {
      const { offset, limit } = parsePagination(req);
      res.json({ items: [], hasMore: false, offset, limit });
    });
    app.get('/api/projects', (req, res) => this.handleProjects(req, res));
    app.get('/api/stats', (req, res) => this.handleStats(req, res));
    app.get('/api/processing-status', (req, res) => this.handleProcessingStatus(req, res));
    app.get('/api/settings', (_req, res) => res.json({}));
    app.get('/stream', (req, res) => this.handleStream(req, res));
  }

  private async handleObservations(req: Request, res: Response, summariesOnly: boolean): Promise<void> {
    try {
      const { offset, limit, project } = parsePagination(req);
      const kindFilter = summariesOnly ? "AND o.kind = 'summary'" : '';
      const projectFilter = project ? 'AND p.name = $3' : '';
      const params: unknown[] = project ? [limit + 1, offset, project] : [limit + 1, offset];
      const result = await this.pool.query<ViewerObservationRow>(
        `SELECT o.id, o.server_session_id, p.name AS project_name, o.kind, o.content,
                o.metadata, o.created_at
           FROM observations o
           LEFT JOIN projects p ON o.project_id = p.id
          WHERE 1=1 ${kindFilter} ${projectFilter}
          ORDER BY o.created_at DESC
          LIMIT $1 OFFSET $2`,
        params
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(mapObservationToViewer);
      res.json({ items, hasMore, offset, limit });
    } catch (err) {
      logger.error('SYSTEM', 'viewer /api/observations failed', { error: String(err) });
      res.status(500).json({ error: 'InternalError', message: 'Failed to list observations' });
    }
  }

  private async handleProjects(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.pool.query<{ name: string }>(
        'SELECT name FROM projects ORDER BY name ASC'
      );
      const projects = result.rows.map(r => r.name);
      res.json({ projects, sources: ['claude'], projectsBySource: { claude: projects } });
    } catch (err) {
      logger.error('SYSTEM', 'viewer /api/projects failed', { error: String(err) });
      res.status(500).json({ error: 'InternalError', message: 'Failed to list projects' });
    }
  }

  private async handleStats(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.pool.query<{
        total_observations: string;
        total_sessions: string;
        total_summaries: string;
        first_observation_at: Date | null;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM observations) AS total_observations,
           (SELECT COUNT(*) FROM server_sessions) AS total_sessions,
           (SELECT COUNT(*) FROM observations WHERE kind = 'summary') AS total_summaries,
           (SELECT MIN(created_at) FROM observations) AS first_observation_at`
      );
      const row = result.rows[0];
      res.json({
        runtime: 'server-beta',
        totalObservations: Number(row?.total_observations ?? 0),
        totalSessions: Number(row?.total_sessions ?? 0),
        totalSummaries: Number(row?.total_summaries ?? 0),
        firstObservationAt: row?.first_observation_at
          ? new Date(row.first_observation_at).toISOString()
          : null,
      });
    } catch (err) {
      logger.error('SYSTEM', 'viewer /api/stats failed', { error: String(err) });
      res.status(500).json({ error: 'InternalError', message: 'Failed to compute stats' });
    }
  }

  private async handleProcessingStatus(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.pool.query<CountRow>(
        "SELECT COUNT(*) AS count FROM observation_generation_jobs WHERE status IN ('queued','processing')"
      );
      const queueDepth = Number(result.rows[0]?.count ?? 0);
      res.json({ isProcessing: queueDepth > 0, queueDepth });
    } catch (err) {
      logger.error('SYSTEM', 'viewer /api/processing-status failed', { error: String(err) });
      res.status(500).json({ error: 'InternalError', message: 'Failed to read processing status' });
    }
  }

  private handleStream(req: Request, res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* closed */ }
    }, 30000);
    req.on('close', () => clearInterval(keepalive));
  }
}
