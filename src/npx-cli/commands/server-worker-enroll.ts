// SPDX-License-Identifier: Apache-2.0
//
// mTLS worker enrollment — `server worker-enroll` mints a `certs:issue`-scoped
// API key and returns a one-line enrollment token. A worker uses this key to
// request a client certificate from the CA (POST /v1/worker-certs), so the key
// is intentionally narrow (certs:issue only) — it must NOT carry memories scopes.
//
// We reuse the production key-gen (createRawApiKey), hashing (hashApiKey), and
// repository insert path (PostgresAuthRepository.createApiKey). Do NOT invent a
// parallel key scheme here. Mirrors src/npx-cli/commands/server-enroll.ts.

import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import { PostgresAuthRepository } from '../../storage/postgres/auth.js';
import { createRawApiKey, hashApiKey } from '../../services/hooks/server-beta-bootstrap.js';
import { encodeEnrollment } from '../../services/hooks/enrollment.js';

export const WORKER_ENROLL_SCOPES: readonly string[] = Object.freeze(['certs:issue']);

const ACTOR = 'system:worker-enroll';

/**
 * Minimal repository surface used by createWorkerEnrollment. Lets tests inject a
 * fake repo without a live Postgres connection while still matching the
 * production PostgresAuthRepository shape.
 */
interface AuthRepoLike {
  createApiKey(input: {
    keyHash: string;
    teamId?: string | null;
    projectId?: string | null;
    actorId: string;
    scopes?: unknown[];
  }): Promise<{ id: string }>;
  createAuditLog(input: Record<string, unknown>): Promise<void>;
}

export interface CreateWorkerEnrollmentInput {
  /** A pg Pool or PoolClient (anything queryable). */
  pool: PostgresQueryable;
  teamId: string;
  serverUrl: string;
  label?: string;
  /** Injectable repo for tests; defaults to PostgresAuthRepository(pool). */
  repo?: AuthRepoLike;
}

export interface CreateWorkerEnrollmentResult {
  rawKey: string;
  apiKeyId: string;
  token: string;
}

export async function createWorkerEnrollment(
  input: CreateWorkerEnrollmentInput,
): Promise<CreateWorkerEnrollmentResult> {
  const rawKey = createRawApiKey();
  const repo = input.repo ?? new PostgresAuthRepository(input.pool);
  const created = await repo.createApiKey({
    keyHash: hashApiKey(rawKey),
    teamId: input.teamId,
    projectId: null,
    actorId: input.label ? `${ACTOR}:${input.label}` : ACTOR,
    scopes: [...WORKER_ENROLL_SCOPES],
  });

  // Audit log is best-effort: a failure must NOT orphan the already-created key.
  try {
    await repo.createAuditLog({
      teamId: input.teamId,
      actorId: ACTOR,
      apiKeyId: created.id,
      action: 'api_key.create',
      resourceType: 'api_key',
      resourceId: created.id,
      details: { source: 'worker-enroll', label: input.label ?? null },
    });
  } catch {
    /* best-effort audit */
  }

  return {
    rawKey,
    apiKeyId: created.id,
    token: encodeEnrollment({ url: input.serverUrl, key: rawKey }),
  };
}
