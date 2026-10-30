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

// Device label for self-enrollment: same alphabet as docs/ops/enroll.sh plus '@'
// so the default `user@host` fits.
export const ENROLL_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

export function defaultEnrollLabel(username: string, hostname: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  const label = [clean(username), clean(hostname)].filter(Boolean).join('@');
  return label || 'client';
}

/**
 * Exchange the team join secret for a per-device API key via POST /v1/enroll.
 * Returns an enrollment token for the URL the client actually used.
 */
export async function requestSelfEnrollment(
  input: { serverUrl: string; secret: string; label: string },
  doFetch: typeof fetch = fetch,
): Promise<string> {
  const url = input.serverUrl.replace(/\/$/, '');
  const resp = await doFetch(`${url}/v1/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.secret}` },
    body: JSON.stringify({ label: input.label }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Self-enrollment failed (HTTP ${resp.status}): ${detail}`);
  }
  const body = (await resp.json()) as { key?: unknown };
  if (typeof body.key !== 'string' || !body.key) throw new Error('Self-enrollment returned no key');
  return encodeEnrollment({ url, key: body.key });
}
