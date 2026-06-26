import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { type CaMaterial, signCsr, type SignedCert } from './ca.js';

export interface CaSigner {
  caPem: string;
  /** Sign a worker CSR into a short-lived client cert. */
  sign(csrPem: string, commonName: string): { certPem: string; caPem: string } & SignedCert;
}

export function writeCaMaterial(dir: string, ca: CaMaterial): { certFile: string; keyFile: string } {
  mkdirSync(dir, { recursive: true });
  const certFile = join(dir, 'ca.crt');
  const keyFile = join(dir, 'ca.key');
  writeFileSync(certFile, ca.certPem, { mode: 0o644 });
  writeFileSync(keyFile, ca.keyPem, { mode: 0o600 });
  return { certFile, keyFile };
}

/** Random positive serial as a hex string (leading 0 byte avoids a negative INTEGER). */
export function newSerial(): string {
  return '00' + randomBytes(16).toString('hex');
}

export function loadCaSigner(opts: { certFile: string; keyFile: string; ttlDays: number }): CaSigner | null {
  if (!existsSync(opts.certFile) || !existsSync(opts.keyFile)) return null;
  const caCertPem = readFileSync(opts.certFile, 'utf8');
  const caKeyPem = readFileSync(opts.keyFile, 'utf8');
  return {
    caPem: caCertPem,
    sign(csrPem: string, commonName: string) {
      const signed = signCsr({ caCertPem, caKeyPem, csrPem, days: opts.ttlDays, serial: newSerial(), eku: 'client' });
      // commonName is recorded by the caller; the leaf CN comes from the CSR.
      void commonName;
      return { ...signed, caPem: caCertPem };
    },
  };
}
