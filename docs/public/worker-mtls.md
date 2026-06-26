# Worker mTLS (enroll-based)

## Overview

Remote and horizontally-scaled `server-beta` generation workers connect to
Valkey over **mutual TLS**. Each worker authenticates with a short-lived,
per-worker **client certificate** that it obtains at startup through an
enrollment flow — it generates its own keypair locally, sends only a CSR to the
server's CA, and receives a signed certificate back.

No private key is ever baked into a package or shipped to a worker. The only
secret a worker is handed is a narrowly-scoped enrollment API key, which can be
revoked at any time. mTLS gives you both wire encryption and mutual
authentication: Valkey verifies the worker, and the worker verifies Valkey.

This applies **only to operator-run workers**. Regular clients (Claude Code
hooks) never talk to Valkey and never need any of this.

## 1. One-time server setup

Initialize a CA and a Valkey server certificate. The CA key is what signs both
the Valkey server cert and every worker client cert.

```bash
server ca init [--dir <path>] [--dns valkey,localhost]
```

This writes four files into `<path>` (default `~/.claude-mem/tls`):

- `ca.crt`, `ca.key` — the certificate authority
- `valkey.crt`, `valkey.key` — the Valkey server certificate (with the supplied
  DNS SANs, default `valkey,localhost`)

The command prints the environment variables to set. On the **server (HTTP)
service**, point it at the CA so it can sign worker CSRs:

```bash
CLAUDE_MEM_CA_CERT_FILE=/path/to/ca.crt
CLAUDE_MEM_CA_KEY_FILE=/path/to/ca.key
```

With both set, the server exposes `POST /v1/worker-certs` (gated by the
`certs:issue` scope) and will sign incoming worker CSRs.

## 2. Enroll a worker

For each worker, mint a dedicated enrollment key:

```bash
server worker-enroll [--url <reachable-server-url>] [--label <name>]
```

This creates a `certs:issue`-scoped API key (it carries **no** memory scopes)
and prints the two values to put on the worker:

```bash
CLAUDE_MEM_SERVER_BETA_URL=https://<server-host>:<port>
CLAUDE_MEM_SERVER_BETA_API_KEY=<certs:issue-scoped key>
```

Pass `--url` with a host the worker can actually reach (tailnet or public URL);
without it the command falls back to a localhost URL, which remote workers
cannot use.

## 3. Worker environment

Set the following on the worker:

```bash
CLAUDE_MEM_WORKER_TLS_DIR=/var/lib/claude-mem/tls   # where the worker stores its cert
CLAUDE_MEM_SERVER_BETA_URL=https://<server-host>:<port>
CLAUDE_MEM_SERVER_BETA_API_KEY=<certs:issue-scoped key>
CLAUDE_MEM_REDIS_URL=rediss://<reachable-valkey-host>:6379
```

Note the `rediss://` scheme — that is what activates TLS on the Redis/Valkey
connection.

On startup the worker:

1. Generates an RSA keypair **locally**.
2. POSTs a CSR (not the key) to `/v1/worker-certs` using the enrollment key.
3. Writes `worker.key` (mode `0600`), `worker.crt`, and `ca.crt` into
   `CLAUDE_MEM_WORKER_TLS_DIR`, and points ioredis at them.

Certificates are short-lived (default **7 days**). The worker re-checks daily
and **auto-renews** when the certificate is within 2 days of expiry — issuing a
fresh CSR with the same enrollment key. If a reusable, still-valid cert already
exists on disk, startup reuses it instead of re-issuing.

Auto-renewal writes the fresh cert to disk, but a long-running worker that has
already connected keeps using its **original** cert on the live ioredis/BullMQ
connection. To pick up a renewed cert on a **new** connection, restart (or
redeploy) the worker. Operator-run workers are typically redeployed regularly,
so this is normally a non-issue — the short TTL plus restart-on-redeploy is the
intended refresh path.

## 4. Valkey mTLS

Run Valkey (or Redis) with TLS-only, client-auth-required settings, mounting the
CA and the server cert produced by `server ca init`:

```bash
valkey-server \
  --tls-port 6379 \
  --port 0 \
  --tls-cert-file valkey.crt \
  --tls-key-file valkey.key \
  --tls-ca-cert-file ca.crt \
  --tls-auth-clients yes
```

`--port 0` disables the plaintext listener so only mTLS connections are
accepted. `--tls-auth-clients yes` forces every client to present a certificate
signed by `ca.crt`.

## 5. Revocation

Each worker's access hinges on its enrollment key. To cut a worker off:

```bash
server api-key revoke <id>
```

Once revoked, the worker's next renewal attempt is denied, and its current
short-lived certificate simply **expires within its TTL** (default 7 days, or
less depending on remaining lifetime).

Valkey/Redis has no CRL or OCSP, so revocation is by **expiry**, not by
invalidating a certificate mid-life. Keep the cert TTL short if you need a
tighter revocation window.

Every issued certificate is recorded in the `worker_certs` table (serial,
SHA-256 fingerprint, common name, `not_after`, `issued_at`) for audit.

## 6. Security notes

- The worker's **private key is generated on the worker and never transmitted** —
  only the CSR leaves the worker. The key is never shipped in any package.
- mTLS provides **both encryption and mutual authentication**: Valkey
  authenticates the worker via its client cert, and the worker authenticates
  Valkey via the CA.
- The enrollment key is **`certs:issue`-scoped only** — it can request
  certificates but cannot read or write memories.
- **Clients (Claude Code hooks) do not use Valkey.** Only operator-run workers
  participate in mTLS; nothing about this setup touches end-user installs.
