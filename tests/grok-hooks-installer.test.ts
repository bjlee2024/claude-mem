import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  buildGrokHooksConfig,
  installGrokHooks,
  uninstallGrokHooks,
  checkGrokHooksStatus,
} from '../src/services/integrations/GrokHooksInstaller.js';

describe('buildGrokHooksConfig', () => {
  it('registers write-tool PostToolUse matcher and lifecycle events', () => {
    const cfg = buildGrokHooksConfig();
    expect(cfg.hooks.SessionStart).toBeDefined();
    expect(cfg.hooks.UserPromptSubmit).toBeDefined();
    expect(cfg.hooks.Stop).toBeDefined();
    expect(cfg.hooks.SessionEnd).toBeDefined();
    expect(cfg.hooks.PostToolUse?.[0]?.matcher).toContain('search_replace');
    expect(cfg.hooks.PostToolUse?.[0]?.matcher).toContain('run_terminal_command');
    const cmd = cfg.hooks.SessionStart?.[0]?.hooks?.[0]?.command ?? '';
    // Relative to hooks JSON dir (Grok docs format) — not quoted absolute paths
    expect(cmd).toBe('bin/claude-mem-client.py');
    expect(JSON.stringify(cfg)).not.toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}/);
    expect(cmd).not.toMatch(/^"/);
  });
});

describe('GrokHooksInstaller install/uninstall', () => {
  let home: string;
  let prevGrokHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'grok-hooks-test-'));
    prevGrokHome = process.env.GROK_HOME;
    process.env.GROK_HOME = join(home, '.grok');
  });

  afterEach(() => {
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('install writes managed hooks file and uninstall removes it', async () => {
    const code = await installGrokHooks();
    // In-repo checkout resolves plugin/scripts/grok-client.py via cwd probe.
    expect(code).toBe(0);

    const hooksFile = join(process.env.GROK_HOME!, 'hooks', 'claude-mem.json');
    const clientFile = join(process.env.GROK_HOME!, 'hooks', 'bin', 'claude-mem-client.py');
    expect(existsSync(hooksFile)).toBe(true);
    expect(existsSync(clientFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(hooksFile, 'utf-8'));
    expect(parsed.hooks.PostToolUse[0].matcher).toContain('search_replace');
    expect(parsed.hooks.SessionStart).toBeDefined();
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe('bin/claude-mem-client.py');

    const un = uninstallGrokHooks();
    expect(un).toBe(0);
    expect(existsSync(hooksFile)).toBe(false);
    expect(existsSync(clientFile)).toBe(false);
  });

  it('status is non-throwing when nothing installed', () => {
    expect(checkGrokHooksStatus()).toBe(0);
  });

  it('uninstall removes legacy filename if present', () => {
    const hooksDir = join(process.env.GROK_HOME!, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const legacy = join(hooksDir, 'claude-mem-server-beta.json');
    writeFileSync(legacy, JSON.stringify({ hooks: {} }), 'utf-8');

    expect(uninstallGrokHooks()).toBe(0);
    expect(existsSync(legacy)).toBe(false);
  });
});

describe('install-paths Grok helpers', () => {
  it('exports getGrokClientAbsolutePath and getPythonAbsolutePath', async () => {
    const paths = await import('../src/services/integrations/install-paths.js');
    expect(typeof paths.getGrokClientAbsolutePath).toBe('function');
    expect(typeof paths.getPythonAbsolutePath).toBe('function');
    const py = paths.getPythonAbsolutePath();
    expect(py.length).toBeGreaterThan(0);
    const client = paths.getGrokClientAbsolutePath();
    expect(client).toBeTruthy();
    expect(client!.endsWith('grok-client.py')).toBe(true);
  });
});

describe('platform-source grok', () => {
  it('normalizes grok variants to grok', async () => {
    const { normalizePlatformSource } = await import('../src/shared/platform-source.js');
    expect(normalizePlatformSource('grok')).toBe('grok');
    expect(normalizePlatformSource('Grok Build')).toBe('grok');
  });
});

describe('package ships grok-client.py', () => {
  it('includes plugin/scripts/*.py in package.json files', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8'));
    expect(pkg.files).toContain('plugin/scripts/*.py');
    expect(existsSync(join(import.meta.dir, '..', 'plugin', 'scripts', 'grok-client.py'))).toBe(true);
  });
});
