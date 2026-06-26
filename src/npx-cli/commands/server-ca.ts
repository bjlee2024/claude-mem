import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createCa, signCsr } from '../../server/security/ca.js';
import { newSerial } from '../../server/security/ca-store.js';
import { generateKeyAndCsr } from '../../shared/mtls/csr.js';

export interface InitCaResult {
  caCertFile: string; caKeyFile: string;
  serverCertFile: string; serverKeyFile: string;
}

/** Generate a CA + a Valkey server cert (serverAuth + DNS SANs) into dir. */
export function initCa(opts: { dir: string; dnsNames: string[]; caDays?: number; serverDays?: number }): InitCaResult {
  mkdirSync(opts.dir, { recursive: true });
  const ca = createCa({ commonName: 'claude-mem worker CA', days: opts.caDays ?? 3650 });
  const caCertFile = join(opts.dir, 'ca.crt');
  const caKeyFile = join(opts.dir, 'ca.key');
  writeFileSync(caCertFile, ca.certPem, { mode: 0o644 });
  writeFileSync(caKeyFile, ca.keyPem, { mode: 0o600 });

  const { keyPem, csrPem } = generateKeyAndCsr({ commonName: opts.dnsNames[0] ?? 'valkey' });
  const serverCert = signCsr({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, csrPem, days: opts.serverDays ?? 365, serial: newSerial(), eku: 'server', dnsNames: opts.dnsNames });
  const serverCertFile = join(opts.dir, 'valkey.crt');
  const serverKeyFile = join(opts.dir, 'valkey.key');
  writeFileSync(serverCertFile, serverCert.certPem, { mode: 0o644 });
  writeFileSync(serverKeyFile, keyPem, { mode: 0o600 });

  return { caCertFile, caKeyFile, serverCertFile, serverKeyFile };
}

/** CLI entry: `server ca init [--dir <path>] [--dns valkey,localhost]`. */
export async function runServerCaCommand(argv: string[]): Promise<void> {
  const sub = argv[0]?.toLowerCase();
  if (sub !== 'init') {
    console.error('Usage: server ca init [--dir <path>] [--dns valkey,localhost]');
    process.exit(1);
  }
  let dir = join(process.env.HOME ?? '.', '.claude-mem', 'tls');
  let dns = ['valkey', 'localhost'];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) { dir = argv[++i]; }
    else if (argv[i] === '--dns' && argv[i + 1]) { dns = argv[++i].split(',').map(s => s.trim()).filter(Boolean); }
  }
  const result = initCa({ dir, dnsNames: dns });
  console.log('CA + Valkey server cert written:');
  console.log(`  CLAUDE_MEM_CA_CERT_FILE=${result.caCertFile}`);
  console.log(`  CLAUDE_MEM_CA_KEY_FILE=${result.caKeyFile}`);
  console.log(`  Valkey: --tls-cert-file ${result.serverCertFile} --tls-key-file ${result.serverKeyFile} --tls-ca-cert-file ${result.caCertFile}`);
}
