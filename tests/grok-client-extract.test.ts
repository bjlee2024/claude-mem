import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const CLIENT = join(import.meta.dir, '..', 'plugin', 'scripts', 'grok-client.py');

function runPython(script: string): string {
  const result = spawnSync('python3', ['-c', script], {
    encoding: 'utf-8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `python exited ${result.status}`);
  }
  return (result.stdout || '').trim();
}

describe('grok-client prompt extraction', () => {
  it('unwraps <user_query> from chat_history.jsonl and skips synthetic users', () => {
    const root = mkdtempSync(join(tmpdir(), 'grok-client-extract-'));
    try {
      const sessionDir = join(root, 'enc', 'sid');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'chat_history.jsonl'),
        [
          JSON.stringify({ type: 'user', synthetic_reason: 'skills', content: [{ type: 'text', text: 'ignore me' }] }),
          JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\nlist grok history\n</user_query>' }], prompt_index: 0 }),
        ].join('\n') + '\n',
        'utf-8',
      );

      const out = runPython(`
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("grok_client", ${JSON.stringify(CLIENT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.SESSIONS_ROOT = ${JSON.stringify(root)}
print(mod.extract_user_prompt({}, "sid", "/unused"))
`);
      expect(out).toBe('list grok history');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads nested settings.env for server-beta credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'grok-client-settings-'));
    try {
      const settingsPath = join(root, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify({
          env: {
            CLAUDE_MEM_SERVER_BETA_URL: 'http://example.invalid:37700',
            CLAUDE_MEM_SERVER_BETA_API_KEY: 'cmem_test',
          },
        }),
        'utf-8',
      );
      const out = runPython(`
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("grok_client", ${JSON.stringify(CLIENT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.SETTINGS_PATH = Path(${JSON.stringify(settingsPath)})
print(mod.load_settings()["url"])
`);
      expect(out).toBe('http://example.invalid:37700');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers hook payload prompt over disk history', () => {
    const out = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("grok_client", ${JSON.stringify(CLIENT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(mod.extract_user_prompt({"prompt": "from hook"}, "missing", "/tmp"))
`);
    expect(out).toBe('from hook');
  });
});
