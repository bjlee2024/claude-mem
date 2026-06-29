// SPDX-License-Identifier: Apache-2.0
import path from 'path';
import pc from 'picocolors';
import { execFileSync } from 'child_process';
import { getProjectName } from '../../utils/project-name.js';

// old (folder-name) logic: repo root basename if in a git repo, else cwd basename
function oldFolderName(cwd: string): string {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.basename(root || cwd);
  } catch {
    return path.basename(cwd);
  }
}

export function computeRename(cwd: string): { oldName: string; newName: string; changed: boolean } {
  const oldName = oldFolderName(cwd);
  const newName = getProjectName(cwd);
  return { oldName, newName, changed: oldName !== newName };
}

// Optional `_cwd` parameter is exposed for testing; production callers omit it.
export async function runProjectCommand(argv: string[], _cwd?: string): Promise<void> {
  const sub = argv[0];
  if (sub !== 'migrate') {
    console.error(pc.red('Usage: claude-mem project migrate [--dry-run]'));
    process.exit(1);
  }
  const dryRun = argv.includes('--dry-run');
  const cwd = _cwd ?? process.cwd();
  const { oldName, newName, changed } = computeRename(cwd);
  if (!changed) {
    console.log(`No change: project is already "${newName}".`);
    return;
  }
  console.log(`${oldName}  →  ${newName}`);
  if (dryRun) {
    console.log('(dry-run: no changes sent)');
    return;
  }

  const { buildClientRuntimeContext } = await import('../../services/hooks/runtime-selector.js');
  const ctx = buildClientRuntimeContext();
  if (!ctx) {
    console.error(
      pc.red('client runtime not configured (CLAUDE_MEM_SERVER_BETA_URL/API_KEY missing).'),
    );
    process.exit(1);
  }
  const { ProjectResolver } = await import('../../services/hooks/project-resolver.js');
  const { DATA_DIR } = await import('../../shared/paths.js');
  const { join } = await import('path');
  const resolver = new ProjectResolver({
    client: ctx.client,
    mapPath: join(DATA_DIR, 'project-map.json'),
  });
  const result = await ctx.client.renameProject(oldName, newName);
  if (result.renamed && result.id) {
    resolver.applyRename(oldName, newName, result.id);
    console.log(pc.green(`Renamed${result.merged ? ' (merged into existing)' : ''}.`));
  } else {
    console.log('Nothing to rename on the server (no existing project by the old name).');
  }
}
