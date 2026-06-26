import forge from 'node-forge';

export interface CaMaterial { certPem: string; keyPem: string }

/** Generate a self-signed CA (cert + key). The key signs worker/server certs. */
export function createCa(opts: { commonName: string; days: number }): CaMaterial {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(cert.validity.notBefore.getTime() + opts.days * 86_400_000);
  const attrs = [{ name: 'commonName', value: opts.commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

export interface SignedCert { certPem: string; notAfter: Date; serial: string; fingerprintSha256: string }

/** Sign a CSR into a short-lived leaf cert chained to the CA. */
export function signCsr(opts: {
  caCertPem: string;
  caKeyPem: string;
  csrPem: string;
  days: number;
  serial: string;
  eku?: 'client' | 'server';
  dnsNames?: string[];
}): SignedCert {
  const caCert = forge.pki.certificateFromPem(opts.caCertPem);
  const caKey = forge.pki.privateKeyFromPem(opts.caKeyPem);
  // @types/node-forge does not export a named CSR type; derive it from the parser's return type.
  let csr: ReturnType<typeof forge.pki.certificationRequestFromPem>;
  try {
    csr = forge.pki.certificationRequestFromPem(opts.csrPem);
  } catch {
    throw new Error('worker-cert: CSR is not valid PEM');
  }
  if (!csr.publicKey || !csr.verify()) {
    throw new Error('worker-cert: CSR self-signature is invalid');
  }
  const cert = forge.pki.createCertificate();
  cert.publicKey = csr.publicKey;
  cert.serialNumber = opts.serial;
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(cert.validity.notBefore.getTime() + opts.days * 86_400_000);
  cert.setSubject(csr.subject.attributes);
  cert.setIssuer(caCert.subject.attributes);
  // @types/node-forge does not export a named extension type; derive it from setExtensions' param.
  const extensions: Parameters<typeof cert.setExtensions>[0] = [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', clientAuth: opts.eku !== 'server', serverAuth: opts.eku === 'server' },
  ];
  if (opts.dnsNames?.length) {
    extensions.push({ name: 'subjectAltName', altNames: opts.dnsNames.map(value => ({ type: 2, value })) }); // type 2 = DNS
  }
  cert.setExtensions(extensions);
  cert.sign(caKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const fingerprintSha256 = forge.md.sha256.create().update(der).digest().toHex();
  return { certPem, notAfter: cert.validity.notAfter, serial: opts.serial, fingerprintSha256 };
}

/** Parse the notAfter date from a leaf cert PEM (used by the worker to decide renewal). */
export function certNotAfter(certPem: string): Date {
  return forge.pki.certificateFromPem(certPem).validity.notAfter;
}
