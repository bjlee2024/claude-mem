// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — `claude-mem client status` diagnostic.
// Prints the thin-client runtime, server URL, reachability, and offline spool
// depth as pretty JSON so operators can quickly debug sync issues.
import pc from 'picocolors';
import { join } from 'path';
import { buildClientStatus } from '../../cli/client-status.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { DATA_DIR } from '../../shared/paths.js';
import { Spool } from '../../services/hooks/spool.js';

function printClientUsage(): void {
  console.error(`Usage: ${pc.bold('npx claude-mem client <command>')}`);
  console.error('Commands: status');
}

async function runClientStatusCommand(): Promise<void> {
  const settingsPath = join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const loaded = SettingsDefaultsManager.loadFromFile(settingsPath);

  const runtime = loaded.CLAUDE_MEM_RUNTIME || SettingsDefaultsManager.get('CLAUDE_MEM_RUNTIME');
  const serverBaseUrl =
    loaded.CLAUDE_MEM_SERVER_BETA_URL || SettingsDefaultsManager.get('CLAUDE_MEM_SERVER_BETA_URL');

  const spool = new Spool({ path: join(DATA_DIR, 'spool', 'pending.ndjson') });

  const status = await buildClientStatus({
    runtime,
    serverBaseUrl,
    ping: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${serverBaseUrl}/v1/info`, { signal: controller.signal });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    },
    spoolDepth: () => spool.depth(),
  });

  console.log(JSON.stringify(status, null, 2));
}

export async function runClientCommand(argv: string[] = []): Promise<void> {
  const subCommand = argv[0]?.toLowerCase();

  if (!subCommand) {
    printClientUsage();
    process.exit(1);
  }

  if (subCommand === 'status') {
    await runClientStatusCommand();
    return;
  }

  console.error(pc.red(`Unknown client command: ${subCommand}`));
  printClientUsage();
  process.exit(1);
}
