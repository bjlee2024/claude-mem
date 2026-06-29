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

    // Merge: reassign all project_id references from `from` to `to`, then delete `from`.
    // All tables below carry a composite (project_id, team_id) FK to projects(id, team_id)
    // (schema.ts lines 120, 149, 170, 189, 224, 241).
    const referencingTables = [
      'api_keys',                    // schema.ts line 112 / composite FK line 120
      'audit_log',                   // schema.ts line 140 / composite FK line 149
      'server_sessions',             // schema.ts line 154 / composite FK line 170
      'agent_events',                // schema.ts line 175 / composite FK line 189
      'observation_generation_jobs', // schema.ts line 194 / composite FK line 224
      'observations',                // schema.ts line 229 / composite FK line 241
    ] as const;

    await this.client.query('BEGIN');
    try {
      // Defer all deferrable constraints until COMMIT so that updating
      // agent_events.project_id does not immediately orphan
      // observation_generation_jobs rows (which carry a 3-way FK on
      // (agent_event_id, project_id, team_id) → agent_events).
      await this.client.query('SET CONSTRAINTS ALL DEFERRED');
      for (const table of referencingTables) {
        await this.client.query(
          `UPDATE ${table} SET project_id = $1 WHERE project_id = $2 AND team_id = $3`,
          [toRow.id, fromRow.id, teamId]
        );
      }
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
