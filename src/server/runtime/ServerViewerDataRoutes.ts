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
