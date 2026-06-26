import { describe, it, expect } from 'bun:test';
import forge from 'node-forge';
import { generateKeyAndCsr } from '../../../src/shared/mtls/csr.js';

describe('generateKeyAndCsr', () => {
  it('produces a PEM private key and a CSR whose self-signature verifies', () => {
    const { keyPem, csrPem } = generateKeyAndCsr({ commonName: 'worker-abc' });
    expect(keyPem).toContain('BEGIN RSA PRIVATE KEY');
    expect(csrPem).toContain('BEGIN CERTIFICATE REQUEST');
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    expect(csr.verify()).toBe(true);
    const cn = csr.subject.getField('CN');
    expect(cn.value).toBe('worker-abc');
  });
});
