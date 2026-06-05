// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — `server enroll` mints a TEAM-scoped API key and returns
// a one-line enrollment token for `install --mode client --enroll <token>`.
//
// The minted key is team-scoped (project_id NULL) with memories:read/write so a
// single client device can resolve/write to many per-repo projects under the
// team. We reuse the production key-gen (createRawApiKey), hashing (hashApiKey),
// and repository insert path (PostgresAuthRepository.createApiKey) — do NOT
// invent a parallel key scheme here.

import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import { PostgresAuthRepository } from '../../storage/postgres/auth.js';
import { createRawApiKey, hashApiKey } from '../../services/hooks/server-beta-bootstrap.js';
import { encodeEnrollment } from '../../services/hooks/enrollment.js';

const ENROLL_ACTOR_ID = 'system:server-enroll';

export const ENROLL_API_KEY_SCOPES: readonly string[] = Object.freeze([
  'memories:read',
  'memories:write',
]);

export interface CreateEnrollmentInput {
  /** A pg Pool or PoolClient (anything queryable). */
  pool: PostgresQueryable;
  teamId: string;
  serverUrl: string;
  label?: string;
}

export interface CreateEnrollmentResult {
  rawKey: string;
  apiKeyId: string;
  token: string;
}

export async function createEnrollment(
  input: CreateEnrollmentInput,
): Promise<CreateEnrollmentResult> {
  const rawKey = createRawApiKey();
  const keyHash = hashApiKey(rawKey);

  const repo = new PostgresAuthRepository(input.pool);
  const created = await repo.createApiKey({
    keyHash,
    teamId: input.teamId,
    // KEY REQUIREMENT: team-scoped key so it resolves/writes to many
    // per-repo projects.
    projectId: null,
    actorId: input.label ? `${ENROLL_ACTOR_ID}:${input.label}` : ENROLL_ACTOR_ID,
    scopes: [...ENROLL_API_KEY_SCOPES],
  });

  await repo.createAuditLog({
    teamId: input.teamId,
    actorId: ENROLL_ACTOR_ID,
    apiKeyId: created.id,
    action: 'api_key.create',
    resourceType: 'api_key',
    resourceId: created.id,
    details: { source: 'server-enroll', label: input.label ?? null },
  });

  return {
    rawKey,
    apiKeyId: created.id,
    token: encodeEnrollment({ url: input.serverUrl, key: rawKey }),
  };
}
