import forge from 'node-forge';

/**
 * Generate an RSA keypair and a PKCS#10 CSR locally. The private key never
 * leaves the caller — only the CSR is sent to the server for signing.
 */
export function generateKeyAndCsr(opts: { commonName: string }): { keyPem: string; csrPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: opts.commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    csrPem: forge.pki.certificationRequestToPem(csr),
  };
}
