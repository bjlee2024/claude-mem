import { describe, it, expect } from 'bun:test';
import forge from 'node-forge';
import { createCa, signCsr, certNotAfter } from '../../../src/server/security/ca.js';
import { generateKeyAndCsr } from '../../../src/shared/mtls/csr.js';

describe('CA', () => {
  it('createCa yields a self-signed CA cert with basicConstraints cA=true', () => {
    const ca = createCa({ commonName: 'claude-mem CA', days: 3650 });
    const cert = forge.pki.certificateFromPem(ca.certPem);
    const bc = cert.getExtension('basicConstraints') as { cA?: boolean } | undefined;
    expect(bc?.cA).toBe(true);
  });

  it('signCsr issues a short-lived client cert chained to the CA', () => {
    const ca = createCa({ commonName: 'claude-mem CA', days: 3650 });
    const { csrPem } = generateKeyAndCsr({ commonName: 'worker-1' });
    const signed = signCsr({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, csrPem, days: 7, serial: '0a01', eku: 'client' });
    const caCert = forge.pki.certificateFromPem(ca.certPem);
    const leaf = forge.pki.certificateFromPem(signed.certPem);
    expect(caCert.verify(leaf)).toBe(true);
    const days = (signed.notAfter.getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    const eku = leaf.getExtension('extKeyUsage') as { clientAuth?: boolean } | undefined;
    expect(eku?.clientAuth).toBe(true);
    expect(signed.serial).toBe('0a01');
    expect(signed.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signCsr rejects a CSR whose signature does not verify', () => {
    const ca = createCa({ commonName: 'claude-mem CA', days: 3650 });
    expect(() => signCsr({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, csrPem: '-----BEGIN CERTIFICATE REQUEST-----\nbogus\n-----END CERTIFICATE REQUEST-----', days: 7, serial: '01' })).toThrow();
  });

  it('signCsr with eku=server adds serverAuth + SAN DNS entries', () => {
    const ca = createCa({ commonName: 'claude-mem CA', days: 3650 });
    const { csrPem } = generateKeyAndCsr({ commonName: 'valkey' });
    const signed = signCsr({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, csrPem, days: 365, serial: '01', eku: 'server', dnsNames: ['valkey', 'localhost'] });
    const leaf = forge.pki.certificateFromPem(signed.certPem);
    const eku = leaf.getExtension('extKeyUsage') as { serverAuth?: boolean } | undefined;
    expect(eku?.serverAuth).toBe(true);
    const san = leaf.getExtension('subjectAltName') as { altNames: { value: string }[] } | undefined;
    expect(san?.altNames.map(a => a.value)).toContain('valkey');
  });

  it('rejects a structurally-valid CSR whose signature does not match its public key', () => {
    const ca = createCa({ commonName: 'claude-mem CA', days: 3650 });
    const claimed = forge.pki.rsa.generateKeyPair(2048);
    const attacker = forge.pki.rsa.generateKeyPair(2048);
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = claimed.publicKey;               // CSR claims `claimed`'s key
    csr.setSubject([{ name: 'commonName', value: 'evil' }]);
    csr.sign(attacker.privateKey, forge.md.sha256.create()); // but signed by a different key → verify() must fail
    const csrPem = forge.pki.certificationRequestToPem(csr);
    expect(csrPem).toContain('BEGIN CERTIFICATE REQUEST'); // it IS well-formed PEM (parses)
    expect(() =>
      signCsr({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, csrPem, days: 7, serial: '02', eku: 'client' }),
    ).toThrow();
  });
});
