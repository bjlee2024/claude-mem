# Fork Guide — `@bjlee2024/claude-mem`

> **This repository is a fork of [`thedotmack/claude-mem`](https://github.com/thedotmack/claude-mem).**
> It is published to npm as **[`@bjlee2024/claude-mem`](https://www.npmjs.com/package/@bjlee2024/claude-mem)**
> and ships its own Claude Code plugin marketplace (`bjlee2024`).
>
> This page is the single source of truth for **everything that differs from upstream** —
> what was added, why, how to use it, and the version-by-version history.

- **Upstream:** `thedotmack/claude-mem` — forked at **v13.4.0** (`8463689`, 2026-05-29)
- **This fork:** `bjlee2024/claude-mem` — currently **v13.4.17**
- **Compare every change:** [`thedotmack/main … bjlee2024/main`](https://github.com/thedotmack/claude-mem/compare/main...bjlee2024:claude-mem:main)

---

## TL;DR — what this fork adds

Upstream claude-mem stores memory **on one machine** (local SQLite worker), and an
experimental single-box **server-beta** runtime. This fork keeps all of that and adds a
**distributed, multi-device memory backend** plus a stack of packaging, generation, and
UX improvements:

1. **Client/Server split** — run one **server** (Postgres + Valkey, in Docker) and connect
   any number of **thin clients** (laptop, desktop, the server box itself). Every device
   shares **one memory pool** over a trusted network (e.g. Tailscale). Clients never need a
   provider API key — generation happens on the server.
2. **Subscription-based generation** — the server can generate observations/summaries using
   a **Claude Code OAuth subscription** (no per-call API key) or a **local model (Ollama)**,
   selectable via `CLAUDE_MEM_SERVER_PROVIDER`.
3. **Client-mode memory search** — `mem-search`, the MCP tools, and the CLI all work from a
   thin client by calling the remote server's `/v1/search`.
4. **Server-mode viewer** — the web viewer is fully wired for server-beta (read-only data
   routes, settings save, context preview), with the local-only Advanced panel hidden.
5. **Rebrand & packaging hardening** — published as `@bjlee2024/claude-mem` with its own
   marketplace, clean `npx` installs, and correct plugin artifact bundling.
6. **Many reliability fixes** — CORS for Tailscale/MagicDNS/private networks, hook `PATH`
   resolution for `mise`/`bun`, and server settings endpoints.

For the hands-on walkthrough see **[Server & Client Modes](./public/server-client-modes.mdx)**.

---

## At a glance — upstream vs. this fork

| Capability | Upstream `thedotmack/claude-mem` | This fork `@bjlee2024/claude-mem` |
| --- | --- | --- |
| Local single-machine memory (SQLite worker) | ✅ | ✅ (unchanged) |
| Server-beta runtime (single box) | ✅ (experimental) | ✅ (built upon) |
| **Multi-device client/server split** | ❌ | ✅ `--mode server` / `--mode client` |
| **Thin client (no API key needed)** | ❌ | ✅ generation runs on the server |
| **Subscription / local-model generation** | ❌ | ✅ `CLAUDE_MEM_SERVER_PROVIDER` (Claude OAuth, Ollama) |
| **Offline write spool + crash recovery** | ❌ | ✅ client buffers writes when the server is down |
| **Client-mode search (MCP + CLI)** | ❌ | ✅ remote `/v1/search` |
| **Server-mode web viewer** | partial | ✅ read-only data routes, settings, preview |
| Plugin marketplace | `thedotmack` | `bjlee2024` |
| npm package | `claude-mem` | `@bjlee2024/claude-mem` |

---

## Headline features (with detail)

### 1. Client / Server split

The biggest addition. The hook layer gained a `client` runtime that talks to a remote
server-beta backend over `/v1/*` instead of a local worker.

- **Install modes:** `npx @bjlee2024/claude-mem install --mode server|client`
- **`server enroll`** issues a team-scoped API key + a one-time **enrollment token**; clients
  redeem it to join the shared memory pool.
- **`ProjectResolver`** maps a repo name → server project UUID (with a local cache).
- **Offline write spool** — when the server is unreachable, client writes are appended to a
  local NDJSON spool and replayed later; includes crash-recovery for orphaned in-flight files.
- **`client status`** diagnostic verifies connectivity, project resolution, and enrollment.

→ Guide: **[Server & Client Modes](./public/server-client-modes.mdx)**
→ Design: [client-server-split-design](./superpowers/specs/2026-06-05-client-server-split-design.md) ·
[plan](./superpowers/plans/2026-06-05-client-server-split.md)

### 2. Server-side generation providers

The server can produce observations/summaries without a per-call API key:

- **`ClaudeSubscriptionObservationProvider`** — uses a Claude Code **OAuth bearer** (your
  Claude subscription), and sends the Claude Code system prompt for correct behavior.
- **Local open-source models (Ollama)** — run generation entirely on your own hardware.
- Selected at runtime via **`CLAUDE_MEM_SERVER_PROVIDER`**.

→ Guide: **[Server & Client Modes](./public/server-client-modes.mdx)** includes both the
subscription-generation and local-model (Ollama) sections.
→ Design: [server-subscription-provider-design](./superpowers/specs/2026-06-05-server-subscription-provider-design.md) ·
[plan](./superpowers/plans/2026-06-05-server-subscription-provider.md)

### 3. Client-mode memory search

`mem-search`, the legacy MCP tools (`search` / `timeline` / `get_observations`), and the CLI
search all work from a thin client by calling the remote server's `/v1/search` — so history
is queryable from any enrolled device.

### 4. Server-mode web viewer

- **`ServerViewerDataRoutes`** — read-only viewer API (observations, stats, projects,
  processing, summaries, prompts, settings) backed by Postgres.
- **`POST /api/settings`** and **`/api/context/preview`** so the viewer's settings modal and
  context preview work against server-beta.
- The local-only **Advanced provider/worker panel is hidden** in server-beta mode.

→ Design: [server-beta-viewer-data-routes-design](./superpowers/specs/2026-06-04-server-beta-viewer-data-routes-design.md) ·
[plan](./superpowers/plans/2026-06-04-server-beta-viewer-data-routes.md)

### 5. Startup context rendering (server/client mode)

- The client renders the SessionStart context through the shared **ContextBuilder formatter**
  (recent-activity timeline) instead of a raw dump, loading the active mode first.
- **Session-summary panel + correct timestamps** in server mode — summary rows
  (`kind='summary'`) are mapped into the summary panel, and observation timestamps read the
  server's `createdAtEpoch` (fixes the "Jan 1, 1970" display). *(Unreleased — see changelog.)*

### 6. Rebrand & packaging

Published as `@bjlee2024/claude-mem` with the `bjlee2024` marketplace; user-facing CLI hints,
logos, and i18n READMEs updated. Hardened `npx`/npm installs (node-compatible bundle,
`.claude-plugin/marketplace.json` shipped, tree-sitter peer-dep override, plugin-id fix).

---

## Version changelog (fork-only releases)

All versions build on upstream **v13.4.0**. See [`CHANGELOG.md`](../CHANGELOG.md) for the
auto-generated per-commit detail.

| Version | Summary |
| --- | --- |
| **Unreleased** | Server-mode SessionStart **session-summary panel** + **1970 timestamp** fix (`src/cli/handlers/context.ts`, `ContextBuilder`) |
| 13.4.17 | Hook `PATH` prelude includes `mise` shims + `bun` |
| 13.4.16 | CORS: allow single-label / MagicDNS hostnames (e.g. `omarchy-bj2`) |
| 13.4.15 | CORS: allow same-origin / private-network / Tailscale origins |
| 13.4.14 | `POST /api/settings` returns `{success:true}` so the viewer shows "Saved" |
| 13.4.13 | Add `POST /api/settings` (viewer Save 500'd in server-beta) |
| 13.4.12 | Hide Advanced provider/worker panel in server-beta viewer |
| 13.4.11 | Add `/api/context/preview` for the viewer settings modal |
| 13.4.10 | Fix `plugin.json` name must be the plugin id `claude-mem` |
| 13.4.9 | Client: show recent-activity list at startup (systemMessage) |
| 13.4.8 | Ship `.claude-plugin/marketplace.json` + drop self-dependency |
| 13.4.7 | Ensure published dist carries `.claude-plugin` + createRequire fixes |
| 13.4.6 | Copy `.claude-plugin/marketplace.json` into the marketplace dir |
| 13.4.4 | Legacy search MCP tool works in client mode (remote `/v1/search`) |
| 13.4.3 | Client-mode memory search (MCP + CLI via remote `/v1/search`) |
| 13.4.2 | Node-compatible npx-cli bundle (createRequire banner) |
| 13.4.1 | Fork CLI hints + built artifacts |
| 13.4.0 → fork | Rebrand as `@bjlee2024/claude-mem` with `bjlee2024` marketplace; client/server split, subscription provider, viewer data routes (see features above) |

---

## Fork-specific documentation index

- **[Server & Client Modes](./public/server-client-modes.mdx)** — primary user guide for the
  distributed setup (install, enroll, Tailscale topology).
- **Design specs & plans** (`docs/superpowers/`):
  - [Client/server split — design](./superpowers/specs/2026-06-05-client-server-split-design.md) ·
    [plan](./superpowers/plans/2026-06-05-client-server-split.md)
  - [Server subscription provider — design](./superpowers/specs/2026-06-05-server-subscription-provider-design.md) ·
    [plan](./superpowers/plans/2026-06-05-server-subscription-provider.md)
  - [Server-beta viewer data routes — design](./superpowers/specs/2026-06-04-server-beta-viewer-data-routes-design.md) ·
    [plan](./superpowers/plans/2026-06-04-server-beta-viewer-data-routes.md)
- **Server-beta background** (shared with upstream): [architecture & team vision](./server-beta-architecture-and-team-vision.md) ·
  [parity map](./server-beta-parity-map.md) · [release readiness](./server-beta-release-readiness.md) ·
  [storage boundary](./server-storage-boundary.md) · [migration: worker → server](./migration-worker-to-server.md)

---

## Maintaining this fork

```bash
# Build, sync to the bjlee2024 marketplace + version caches, restart the worker
npm run build-and-sync

# Pull upstream changes (remote `upstream` = thedotmack/claude-mem)
git fetch upstream
git merge upstream/main      # or rebase; resolve rebrand/marketplace conflicts
```

- **Releases & versioning** are handled by the `version-bump` workflow; `CHANGELOG.md` is
  generated automatically (do not hand-edit it).
- The plugin the hooks actually execute lives under
  `~/.claude/plugins/cache/bjlee2024/claude-mem/<version>/` — `build-and-sync` mirrors the
  build into that cache for hot reload.
