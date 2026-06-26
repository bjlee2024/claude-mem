import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { generateKeyAndCsr } from '../../shared/mtls/csr.js';
import { certNotAfter } from '../security/ca.js';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface ProvisionResult { action: 'issued' | 'reused'; keyFile: string; certFile: string; caFile: string }

export async function provisionWorkerCert(opts: {
  dir: string;
  commonName: string;
  serverUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  renewWithinDays?: number;
}): Promise<ProvisionResult> {
  mkdirSync(opts.dir, { recursive: true });
  const keyFile = join(opts.dir, 'worker.key');
  const certFile = join(opts.dir, 'worker.crt');
  const caFile = join(opts.dir, 'ca.crt');
  const renewWithin = (opts.renewWithinDays ?? 2) * 86_400_000;

  if (existsSync(certFile) && existsSync(keyFile) && existsSync(caFile)) {
    try {
      const remaining = certNotAfter(readFileSync(certFile, 'utf8')).getTime() - Date.now();
      if (remaining > renewWithin) return { action: 'reused', keyFile, certFile, caFile };
    } catch { /* unreadable → re-issue */ }
  }

  const { keyPem, csrPem } = generateKeyAndCsr({ commonName: opts.commonName });
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const resp = await doFetch(`${opts.serverUrl.replace(/\/$/, '')}/v1/worker-certs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({ commonName: opts.commonName, csr: csrPem }),
  });
  if (!resp.ok) throw new Error(`worker-cert issuance failed: HTTP ${resp.status}`);
  const body = JSON.parse(await resp.text()) as { cert: string; ca: string };
  writeFileSync(keyFile, keyPem, { mode: 0o600 });
  writeFileSync(certFile, body.cert, { mode: 0o644 });
  writeFileSync(caFile, body.ca, { mode: 0o644 });
  return { action: 'issued', keyFile, certFile, caFile };
}
