// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, PostgresQueryable } from './utils.js';
import { newId, queryOne, toEpoch, toJsonObject, toJsonbText } from './utils.js';

export interface PostgresProject {
  id: string;
  teamId: string;
  name: string;
  metadata: JsonObject;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

interface ProjectRow {
  id: string;
  team_id: string;
  name: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export class PostgresProjectsRepository {
  constructor(private client: PostgresQueryable) {}

  async create(input: {
    id?: string;
    teamId: string;
    name: string;
    metadata?: JsonObject;
  }): Promise<PostgresProject> {
    const id = input.id ?? newId();
    const row = await queryOne<ProjectRow>(
      this.client,
      `
        INSERT INTO projects (id, team_id, name, metadata)
        VALUES ($1, $2, $3, $4::jsonb)
        RETURNING *
      `,
      [id, input.teamId, input.name, toJsonbText(input.metadata)]
    );
    return mapProjectRow(row!);
  }

  async getByIdForTeam(id: string, teamId: string): Promise<PostgresProject | null> {
    const row = await queryOne<ProjectRow>(
      this.client,
      'SELECT * FROM projects WHERE id = $1 AND team_id = $2',
      [id, teamId]
    );
    return row ? mapProjectRow(row) : null;
  }

  /**
   * Rename `from` project to `to`, or merge `from` into an existing `to` project.
   *
   * - `from` not found → returns null.
   * - `to` name is free → UPDATE projects SET name, returns { id, name, merged: false }.
   * - `to` already exists → in a single transaction reassign every project_id reference
   *   from `from.id` to `to.id` across all referencing tables, then DELETE `from` row.
   *   Returns { id: to.id, name, merged: true }.
   *
   * Reference tables are sourced from src/storage/postgres/schema.ts; every table
   * carries a composite (project_id, team_id) FK to projects(id, team_id), so all
   * UPDATEs are scoped with WHERE project_id = $2 AND team_id = $3.
   */
  async renameOrMerge(
    teamId: string,
    from: string,
    to: string
  ): Promise<{ id: string; name: string; merged: boolean } | null> {
    const fromRow = await queryOne<{ id: string }>(
      this.client,
      'SELECT id FROM projects WHERE team_id = $1 AND name = $2',
      [teamId, from]
    );
    if (!fromRow) return null;

    const toRow = await queryOne<{ id: string }>(
      this.client,
      'SELECT id FROM projects WHERE team_id = $1 AND name = $2',
      [teamId, to]
    );

    if (!toRow) {
      // Simple rename — no transaction needed.
      await queryOne(
        this.client,
        'UPDATE projects SET name = $1, updated_at = now() WHERE id = $2 RETURNING id',
        [to, fromRow.id]
      );
      return { id: fromRow.id, name: to, merged: false };
    }

    // Guard: if from and to resolve to the same project, return early.
    // This prevents accidental cascade deletion when the user renames to itself.
    if (fromRow.id === toRow.id) {
      return { id: fromRow.id, name: to, merged: false };
    }

    // Merge: for tables with a project_id-bearing UNIQUE constraint, DELETE the
    // from-rows that would collide before re-assigning the rest to to.  Tables
    // without such a constraint (api_keys, audit_log, agent_events) keep a plain
    // UPDATE.  All child rows of deleted server_sessions are preserved because
    // every server_session_id FK uses ON DELETE SET NULL.
    //
    // Unique constraints that require pre-deletion (schema.ts):
    //   server_sessions: UNIQUE (project_id, external_session_id)             line 169
    //   server_sessions: UNIQUE (project_id, idempotency_key) WHERE NOT NULL  line 296
    //   observations:    UNIQUE (team_id, project_id, generation_key) WHERE NOT NULL  line 299
    //   observation_generation_jobs: UNIQUE (team_id, project_id, source_type, source_id, job_type)  line 302

    await this.client.query('BEGIN');
    try {
      // Defer the 3-way FK observation_generation_jobs → agent_events so we can
      // update agent_events.project_id before observation_generation_jobs.
      await this.client.query('SET CONSTRAINTS ALL DEFERRED');

      // ── api_keys: no project_id-bearing unique constraint → plain UPDATE ──
      await this.client.query(
        `UPDATE api_keys SET project_id = $1 WHERE project_id = $2 AND team_id = $3`,
        [toRow.id, fromRow.id, teamId]
      );

      // ── audit_log: no project_id-bearing unique constraint → plain UPDATE ──
      await this.client.query(
        `UPDATE audit_log SET project_id = $1 WHERE project_id = $2 AND team_id = $3`,
        [toRow.id, fromRow.id, teamId]
      );

      // ── server_sessions: TWO unique keys involving project_id ──
      // Key 1: (project_id, external_session_id)
      // Key 2: (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL
      // Delete any from-session that would collide on EITHER key.
      await this.client.query(
        `DELETE FROM server_sessions f
          WHERE f.project_id = $1 AND f.team_id = $2
            AND (
              EXISTS (
                SELECT 1 FROM server_sessions t
                WHERE t.project_id = $3 AND t.team_id = $2
                  AND t.external_session_id = f.external_session_id
              )
              OR (
                f.idempotency_key IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM server_sessions t
                  WHERE t.project_id = $3 AND t.team_id = $2
                    AND t.idempotency_key = f.idempotency_key
                )
              )
            )`,
        [fromRow.id, teamId, toRow.id]
      );
      await this.client.query(
        `UPDATE server_sessions SET project_id = $1 WHERE project_id = $2 AND team_id = $3`,
        [toRow.id, fromRow.id, teamId]
      );

      // ── agent_events: UNIQUE (id, project_id, team_id) includes own id → no collision ──
      await this.client.query(
        `UPDATE agent_events SET project_id = $1 WHERE project_id = $2 AND team_id = $3`,
        [toRow.id, fromRow.id, teamId]
      );

      // ── observation_generation_jobs: UNIQUE (team_id, project_id, source_type, source_id, job_type) ──
      await this.client.query(
        `DELETE FROM observation_generation_jobs f
          WHERE f.project_id = $1 AND f.team_id = $2
            AND EXISTS (
              SELECT 1 FROM observation_generation_jobs t
              WHERE t.project_id = $3 AND t.team_id = $2
                AND t.source_type = f.source_type
                AND t.source_id = f.source_id
                AND t.job_type = f.job_type
            )`,
        [fromRow.id, teamId, toRow.id]
      );
      await this.client.query(
        `UPDATE observation_generation_jobs SET project_id = $1 WHERE project_id = $2 AND team_id = $3`,
        [toRow.id, fromRow.id, teamId]
      );

      // ── observations: UNIQUE (team_id, project_id, generation_key) WHERE generation_key IS NOT NULL ──
      await this.client.query(
        `DELETE FROM observations f
          WHERE f.project_id = $1 AND f.team_id = $2
            AND f.generation_key IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM observations t
              WHERE t.project_id = $3 AND t.team_id = $2
                AND t.generation_key = f.generation_key
            )`,
        [fromRow.id, teamId, toRow.id]
      );
      await this.client.query(
        `UPDATE observations SET project_id = $1 WHERE project_id = $2 AND team_id = $3`,
        [toRow.id, fromRow.id, teamId]
      );

      await this.client.query('DELETE FROM projects WHERE id = $1', [fromRow.id]);
      await this.client.query('COMMIT');
    } catch (e) {
      await this.client.query('ROLLBACK');
      throw e;
    }
    return { id: toRow.id, name: to, merged: true };
  }
}

function mapProjectRow(row: ProjectRow): PostgresProject {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    metadata: toJsonObject(row.metadata),
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at)
  };
}
