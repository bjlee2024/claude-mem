// SPDX-License-Identifier: Apache-2.0

import type { PostgresQueryable } from './utils.js';
import { newId, queryOne, toEpoch } from './utils.js';

export interface PostgresWorkerCert {
  id: string;
  teamId: string;
  apiKeyId: string | null;
  commonName: string;
  serial: string;
  fingerprintSha256: string;
  notAfterEpoch: number;
  revokedAtEpoch: number | null;
  issuedAtEpoch: number;
}

interface WorkerCertRow {
  id: string;
  team_id: string;
  api_key_id: string | null;
  common_name: string;
  serial: string;
  fingerprint_sha256: string;
  not_after: Date;
  revoked_at: Date | null;
  issued_at: Date;
}

export class PostgresWorkerCertsRepository {
  constructor(private client: PostgresQueryable) {}

  async record(input: {
    teamId: string;
    apiKeyId: string | null;
    commonName: string;
    serial: string;
    fingerprintSha256: string;
    notAfter: Date;
  }): Promise<PostgresWorkerCert> {
    const id = newId();
    const row = await queryOne<WorkerCertRow>(
      this.client,
      `
        INSERT INTO worker_certs (id, team_id, api_key_id, common_name, serial, fingerprint_sha256, not_after)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
      [id, input.teamId, input.apiKeyId, input.commonName, input.serial, input.fingerprintSha256, input.notAfter]
    );
    return mapRow(row!);
  }
}

function mapRow(row: WorkerCertRow): PostgresWorkerCert {
  return {
    id: row.id,
    teamId: row.team_id,
    apiKeyId: row.api_key_id,
    commonName: row.common_name,
    serial: row.serial,
    fingerprintSha256: row.fingerprint_sha256,
    notAfterEpoch: toEpoch(row.not_after),
    revokedAtEpoch: row.revoked_at ? toEpoch(row.revoked_at) : null,
    issuedAtEpoch: toEpoch(row.issued_at)
  };
}
