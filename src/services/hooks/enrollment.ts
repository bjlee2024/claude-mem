// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — a one-line enrollment token bundling the server URL and
// a team-scoped API key, for `install --mode client --enroll <token>`.
export interface Enrollment { url: string; key: string }

export function encodeEnrollment(e: Enrollment): string {
  return Buffer.from(JSON.stringify({ url: e.url, key: e.key }), 'utf8').toString('base64url');
}

export function decodeEnrollment(token: string): Enrollment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid enrollment token');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid enrollment token');
  const { url, key } = parsed as Record<string, unknown>;
  if (typeof url !== 'string' || typeof key !== 'string' || !url || !key) {
    throw new Error('Invalid enrollment token');
  }
  return { url, key };
}
