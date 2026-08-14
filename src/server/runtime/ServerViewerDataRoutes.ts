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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';
import { renderContextFromObservations } from '../../services/context/ContextBuilder.js';
import type { Observation } from '../../services/context/types.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

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
  git_user: string | null;
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

// Row shape for the /api/prompts query. LEFT-joined session/project fields can
// be null: a prompt event can arrive before its server_sessions row exists.
interface ViewerPromptRow {
  id: string;
  content_session_id: string | null;
  project_name: string | null;
  platform_source: string | null;
  prompt_text: string | null;
  occurred_at: Date;
  prompt_number: string;
}

// row_number() returns Postgres bigint, which the pg driver hands back as a
// string — Number() converts it to what the viewer's UserPrompt.prompt_number
// (number) expects.
function mapPromptToViewer(row: ViewerPromptRow) {
  return {
    id: row.id,
    content_session_id: row.content_session_id ?? '',
    project: row.project_name ?? '',
    platform_source: row.platform_source ?? 'claude',
    prompt_number: Number(row.prompt_number),
    prompt_text: row.prompt_text ?? '',
    created_at_epoch: row.occurred_at.getTime(),
  };
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
    // Outbound JSON key must be git_user (snake_case) to match the frontend
    // Observation type and ObservationCard's read of observation.git_user.
    // The internal metadata JSONB key stays gitUser (camelCase) — that's
    // Task 10's persisted shape and what the SQL filter matches on.
    git_user: asStringOrNull(meta.gitUser),
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

// Map a Postgres observation row to the canonical Observation shape the context
// formatter expects (same mapping the client-mode context handler uses).
function mapRowToObservation(row: ViewerObservationRow, idx: number, project: string): Observation {
  const meta = row.metadata && typeof row.metadata === 'object'
    ? (row.metadata as Record<string, unknown>)
    : {};
  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  const asJsonString = (v: unknown): string | null =>
    Array.isArray(v) ? JSON.stringify(v) : typeof v === 'string' ? v : null;
  return {
    id: idx,
    memory_session_id: typeof row.server_session_id === 'string' ? row.server_session_id : '',
    platform_source: typeof meta.provider === 'string' ? meta.provider : undefined,
    type: typeof meta.type === 'string' ? meta.type : (row.kind || 'observation'),
    title: typeof meta.title === 'string' ? meta.title : null,
    // Not folded into title — HumanFormatter/AgentFormatter join git_user and
    // title at render time (formatObservationTitle), same as the local runtime.
    git_user: typeof meta.gitUser === 'string' ? meta.gitUser : null,
    subtitle: typeof meta.subtitle === 'string' ? meta.subtitle : null,
    narrative: typeof meta.narrative === 'string' ? meta.narrative
      : (typeof row.content === 'string' ? row.content : null),
    facts: asJsonString(meta.facts),
    concepts: asJsonString(meta.concepts),
    files_read: asJsonString(meta.files_read),
    files_modified: asJsonString(meta.files_modified),
    discovery_tokens: null,
    created_at: createdAt.toISOString(),
    created_at_epoch: createdAt.getTime(),
    project,
  };
}

export class ServerViewerDataRoutes implements RouteHandler {
  constructor(private readonly pool: PostgresQueryable) {}

  setupRoutes(app: Application): void {
    app.get('/api/observations', (req, res) => this.handleObservations(req, res, false));
    app.get('/api/summaries', (req, res) => this.handleObservations(req, res, true));
    app.get('/api/prompts', (req, res) => this.handlePrompts(req, res));
    app.get('/api/projects', (req, res) => this.handleProjects(req, res));
    app.get('/api/stats', (req, res) => this.handleStats(req, res));
    app.get('/api/processing-status', (req, res) => this.handleProcessingStatus(req, res));
    app.get('/api/settings', (_req, res) => this.handleGetSettings(res));
    app.post('/api/settings', (req, res) => this.handleSaveSettings(req, res));
    app.get('/api/context/preview', (req, res) => this.handleContextPreview(req, res));
    // server-beta logs to stdout (no log file); the viewer's console reads the
    // server process's in-memory log ring buffer instead of returning 404.
    app.get('/api/logs', (_req, res) => res.json({ logs: logger.getRecentLogs() }));
    app.post('/api/logs/clear', (_req, res) => { logger.clearRecentLogs(); res.json({ success: true }); });
    app.get('/stream', (req, res) => this.handleStream(req, res));
  }

  // Viewer settings are persisted to the server's DATA_DIR/settings.json, which
  // loadContextConfig() reads — so saved context settings flow into the /api/context/
  // preview. (Generation provider config remains env-only; the viewer hides that
  // panel in server-beta.) Without a POST handler the viewer's Save 500'd.
  private handleGetSettings(res: Response): void {
    try {
      const data = existsSync(USER_SETTINGS_PATH)
        ? JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf8'))
        : {};
      res.json(data);
    } catch {
      res.json({});
    }
  }

  private handleSaveSettings(req: Request, res: Response): void {
    try {
      const incoming = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      const current = existsSync(USER_SETTINGS_PATH)
        ? JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf8'))
        : {};
      const merged = { ...current, ...incoming };
      mkdirSync(dirname(USER_SETTINGS_PATH), { recursive: true });
      writeFileSync(USER_SETTINGS_PATH, JSON.stringify(merged, null, 2));
      // The viewer checks `result.success`, not HTTP status, to show "✓ Saved".
      res.json({ success: true });
    } catch (err) {
      logger.error('SYSTEM', 'viewer POST /api/settings failed', { error: String(err) });
      res.status(500).json({ error: 'InternalError', message: 'Failed to save settings' });
    }
  }

  // Settings-modal preview. The worker runtime renders this via generateContext()
  // (SQLite); server-beta has no local SQLite, so render the same way from Postgres
  // rows using the shared pure formatter.
  private async handleContextPreview(req: Request, res: Response): Promise<void> {
    try {
      const project = typeof req.query.project === 'string' ? req.query.project : '';
      if (!project) {
        res.status(400).type('text/plain').send('project parameter is required');
        return;
      }
      const result = await this.pool.query<ViewerObservationRow>(
        `SELECT o.id, o.server_session_id, p.name AS project_name, o.kind, o.content,
                o.metadata, o.created_at
           FROM observations o
           LEFT JOIN projects p ON o.project_id = p.id
          WHERE p.name = $1 AND o.kind <> 'summary'
          ORDER BY o.created_at DESC
          LIMIT 50`,
        [project]
      );
      const observations: Observation[] = result.rows.map((row, idx) => mapRowToObservation(row, idx, project));
      const text = renderContextFromObservations(project, observations, `/preview/${project}`, true);
      res.type('text/plain').send(text);
    } catch (err) {
      logger.error('SYSTEM', 'viewer /api/context/preview failed', { error: String(err) });
      res.status(500).type('text/plain').send('Failed to render preview');
    }
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
      const label = summariesOnly ? 'summaries' : 'observations';
      logger.error('SYSTEM', `viewer /api/${label} failed`, { error: String(err) });
      res.status(500).json({ error: 'InternalError', message: `Failed to list ${label}` });
    }
  }

  // A prompt event can arrive before its server_sessions row exists (or
  // reference a project without one), so the JOINs must be LEFT — an INNER
  // JOIN would silently drop those rows even though the prompt text is there.
  private async handlePrompts(req: Request, res: Response): Promise<void> {
    try {
      const { offset, limit, project } = parsePagination(req);
      const projectFilter = project ? 'AND p.name = $3' : '';
      const params: unknown[] = project ? [limit + 1, offset, project] : [limit + 1, offset];
      const result = await this.pool.query<ViewerPromptRow>(
        `SELECT e.id,
                s.content_session_id,
                p.name AS project_name,
                s.platform_source,
                e.payload->>'prompt' AS prompt_text,
                e.occurred_at,
                row_number() OVER (
                  PARTITION BY e.server_session_id ORDER BY e.occurred_at ASC
                ) AS prompt_number
           FROM agent_events e
           LEFT JOIN server_sessions s ON e.server_session_id = s.id
           LEFT JOIN projects p ON e.project_id = p.id
          WHERE e.event_type = 'user_prompt' ${projectFilter}
          ORDER BY e.occurred_at DESC
          LIMIT $1 OFFSET $2`,
        params
      );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(mapPromptToViewer);
      res.json({ items, hasMore, offset, limit });
    } catch (err) {
      logger.error('SYSTEM', 'viewer /api/prompts failed', { error: String(err) });
      res.status(500).json({ error: 'InternalError', message: 'Failed to list prompts' });
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
