# Adapters

Claude Code hook payloads are mapped through `src/adapters/claude-code/mapper.ts` into `AgentEvent` records. The mapper preserves legacy fields such as `contentSessionId`, `tool_name`, `tool_input`, `tool_response`, `cwd`, `agentId`, `agentType`, `platformSource`, and both `tool_use_id` and `toolUseId`.

Generic agent examples live in `src/adapters/generic-rest/examples.ts` for Codex, OpenCode, and custom REST ingestion. New adapters should emit the REST V1 event shape instead of coupling their payloads to Claude Code internals.

## Grok (server-beta client write)

Grok does **not** use the unified `worker-service.cjs hook <platform>` path. Installer
`GrokHooksInstaller` writes `~/.grok/hooks/claude-mem.json`, which runs
`plugin/scripts/grok-client.py` against `CLAUDE_MEM_SERVER_BETA_URL` directly
(`platformSource: "grok"`). See `docs/public/grok/setup.mdx`.
