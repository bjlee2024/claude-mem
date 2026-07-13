// SPDX-License-Identifier: Apache-2.0
//
// Grok Build TUI integration — server-beta client write hooks.
// Does NOT start or depend on the local worker. Hooks POST directly to
// CLAUDE_MEM_SERVER_BETA_URL using the packaged plugin/scripts/grok-client.py.

import path from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import {
  getGrokClientAbsolutePath,
  getPythonAbsolutePath,
} from './install-paths.js';

const WRITE_TOOL_MATCHER =
  'search_replace|write|run_terminal_command|Edit|Write|MultiEdit|Bash';

const HOOK_TIMEOUT_SEC = 10;
const STOP_TIMEOUT_SEC = 15;

/** Resolve at call time so GROK_HOME env overrides work (and tests can isolate). */
function grokHome(): string {
  return process.env.GROK_HOME
    ? path.resolve(process.env.GROK_HOME)
    : path.join(homedir(), '.grok');
}

function grokHooksDir(): string {
  return path.join(grokHome(), 'hooks');
}

function managedHookFile(): string {
  return path.join(grokHooksDir(), 'claude-mem.json');
}

/** Legacy name from the pre-package handoff install — remove on uninstall/upgrade. */
function legacyHookFile(): string {
  return path.join(grokHooksDir(), 'claude-mem-server-beta.json');
}

interface GrokHookHandler {
  type: 'command';
  command: string;
  timeout: number;
}

interface GrokHookGroup {
  matcher?: string;
  hooks: GrokHookHandler[];
}

interface GrokHooksFile {
  description?: string;
  hooks: Record<string, GrokHookGroup[]>;
}

function buildHookCommand(pythonPath: string, clientPath: string): string {
  // Quote paths so spaces in home dirs do not break the shell.
  const q = (p: string) => `"${p.replace(/"/g, '\\"')}"`;
  return `${q(pythonPath)} ${q(clientPath)}`;
}

export function buildGrokHooksConfig(pythonPath: string, clientPath: string): GrokHooksFile {
  const command = buildHookCommand(pythonPath, clientPath);
  const lifecycle = (timeout: number): GrokHookGroup[] => [
    { hooks: [{ type: 'command', command, timeout }] },
  ];
  return {
    description: 'claude-mem server-beta client write (Grok; no local worker)',
    hooks: {
      SessionStart: lifecycle(HOOK_TIMEOUT_SEC),
      UserPromptSubmit: lifecycle(HOOK_TIMEOUT_SEC),
      PostToolUse: [
        {
          matcher: WRITE_TOOL_MATCHER,
          hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SEC }],
        },
      ],
      Stop: lifecycle(STOP_TIMEOUT_SEC),
      SessionEnd: lifecycle(STOP_TIMEOUT_SEC),
    },
  };
}

function readSettingsHint(): { url?: string; hasKey: boolean; runtime?: string } {
  try {
    if (!existsSync(USER_SETTINGS_PATH)) return { hasKey: false };
    const data = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
    return {
      url: typeof data.CLAUDE_MEM_SERVER_BETA_URL === 'string' ? data.CLAUDE_MEM_SERVER_BETA_URL : undefined,
      hasKey: Boolean(data.CLAUDE_MEM_SERVER_BETA_API_KEY),
      runtime: typeof data.CLAUDE_MEM_RUNTIME === 'string' ? data.CLAUDE_MEM_RUNTIME : undefined,
    };
  } catch {
    return { hasKey: false };
  }
}

export async function installGrokHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Grok hooks (server-beta client write)…\n');

  const clientPath = getGrokClientAbsolutePath();
  if (!clientPath) {
    console.error('Could not find grok-client.py');
    console.error('   Expected under plugin/scripts/ next to worker-service.cjs');
    return 1;
  }

  const pythonPath = getPythonAbsolutePath();
  const hooksDir = grokHooksDir();
  const managed = managedHookFile();
  const legacy = legacyHookFile();
  console.log(`  Python:       ${pythonPath}`);
  console.log(`  Client:       ${clientPath}`);
  console.log(`  Hooks dir:    ${hooksDir}`);

  try {
    mkdirSync(hooksDir, { recursive: true });
    const config = buildGrokHooksConfig(pythonPath, clientPath);
    writeFileSync(managed, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.log(`  Wrote:        ${managed}`);

    // Drop legacy handoff filename if present to avoid double-firing hooks.
    if (existsSync(legacy) && legacy !== managed) {
      try {
        unlinkSync(legacy);
        console.log(`  Removed legacy: ${legacy}`);
      } catch {
        /* best-effort */
      }
    }

    const hint = readSettingsHint();
    if (!hint.url || !hint.hasKey) {
      console.log(`
${'⚠'}  Server-beta credentials missing in ~/.claude-mem/settings.json
   Set CLAUDE_MEM_RUNTIME=client, CLAUDE_MEM_SERVER_BETA_URL, and
   CLAUDE_MEM_SERVER_BETA_API_KEY so hooks can write. Hooks are fail-open
   until configured.
`);
    } else {
      console.log(`  Server URL:   ${hint.url}`);
      console.log(`  Runtime:      ${hint.runtime ?? '(unset)'}`);
    }

    console.log(`
Installation complete!

Hooks installed to: ${managed}
Mode: server-beta client write (no local worker required)

Events:
  SessionStart / UserPromptSubmit  → POST /v1/sessions/start
  PostToolUse (write tools only)   → POST /v1/events (tool_use)
  Stop                             → assistant_message + session end
  SessionEnd                       → session end

Next steps:
  1. Ensure client settings point at server-beta (see above).
  2. Restart Grok, or run /hooks and press r to reload.
  3. Confirm claude-mem.json appears in the Hooks tab.

Read path: use MCP search/context tools (SessionStart cannot inject via stdout).
`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

export function uninstallGrokHooks(): number {
  console.log('\nUninstalling Claude-Mem Grok hooks…\n');

  let removed = 0;
  for (const file of [managedHookFile(), legacyHookFile()]) {
    if (!existsSync(file)) continue;
    try {
      unlinkSync(file);
      console.log(`  Removed ${file}`);
      removed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Failed to remove ${file}: ${message}`);
      return 1;
    }
  }

  if (removed === 0) {
    console.log('  No claude-mem Grok hooks found — nothing to uninstall.');
  } else {
    console.log('\nUninstallation complete. Reload hooks in Grok (/hooks → r) or restart.\n');
  }
  return 0;
}

export function checkGrokHooksStatus(): number {
  console.log('\nClaude-Mem Grok Hooks Status\n');

  const clientPath = getGrokClientAbsolutePath();
  console.log(`Client script: ${clientPath ?? 'NOT FOUND'}`);
  console.log(`Python:        ${getPythonAbsolutePath()}`);
  console.log(`Hooks dir:     ${grokHooksDir()}`);

  const present = [managedHookFile(), legacyHookFile()].filter((f) => existsSync(f));
  if (present.length === 0) {
    console.log('Installed:     no');
    console.log('\nRun: npx @bjlee2024/claude-mem install --ide grok\n');
    return 0;
  }

  for (const file of present) {
    console.log(`Installed:     ${file}`);
    try {
      const raw = readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as GrokHooksFile;
      const events = Object.keys(parsed.hooks ?? {});
      console.log(`  Events:      ${events.join(', ')}`);
      const firstCmd =
        parsed.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command ??
        parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.command;
      if (firstCmd) console.log(`  Command:     ${firstCmd}`);
    } catch (error) {
      console.log(`  (unreadable: ${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const hint = readSettingsHint();
  console.log(`Server URL:    ${hint.url ?? '(not set)'}`);
  console.log(`API key:       ${hint.hasKey ? 'set' : 'MISSING'}`);
  console.log(`Runtime:       ${hint.runtime ?? '(unset)'}`);
  console.log('');
  return 0;
}

export async function handleGrokCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
      return installGrokHooks();
    case 'uninstall':
      return uninstallGrokHooks();
    case 'status':
      return checkGrokHooksStatus();
    default:
      console.log(`
Claude-Mem Grok Integration

Server-beta client write hooks for the Grok Build TUI.
No local worker is required — hooks POST to CLAUDE_MEM_SERVER_BETA_URL.

Usage: claude-mem grok <command>

Commands:
  install     Install hooks into ~/.grok/hooks/claude-mem.json
  uninstall   Remove managed claude-mem Grok hooks
  status      Check installation status

Examples:
  npx @bjlee2024/claude-mem install --ide grok
  claude-mem grok install
  claude-mem grok status
  claude-mem grok uninstall
`);
      return 0;
  }
}
