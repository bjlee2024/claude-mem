// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { resolveInstallMode } from '../../src/npx-cli/commands/install.js';
import { encodeEnrollment } from '../../src/services/hooks/enrollment.js';

describe('resolveInstallMode', () => {
  it('--mode client via --enroll maps to runtime=client with server config', () => {
    const token = encodeEnrollment({ url: 'http://h:1', key: 'k' });
    const r = resolveInstallMode({ mode: 'client', enroll: token });
    expect(r.runtime).toBe('client');
    expect(r.serverUrl).toBe('http://h:1');
    expect(r.apiKey).toBe('k');
    expect(r.provision).toBe(false);
  });
  it('--mode client via --server-url + --token', () => {
    const r = resolveInstallMode({ mode: 'client', serverUrl: 'http://h:2', token: 'k2' });
    expect(r.runtime).toBe('client'); expect(r.serverUrl).toBe('http://h:2'); expect(r.apiKey).toBe('k2');
  });
  it('--mode client without creds throws', () => {
    expect(() => resolveInstallMode({ mode: 'client' })).toThrow();
  });
  it('--mode server maps to runtime=server-beta with provisioning + local client default', () => {
    const r = resolveInstallMode({ mode: 'server' });
    expect(r.runtime).toBe('server-beta'); expect(r.provision).toBe(true); expect(r.withLocalClient).toBe(true);
  });
  it('no mode preserves legacy runtime selection', () => {
    expect(resolveInstallMode({ runtime: 'worker' }).runtime).toBe('worker');
    expect(resolveInstallMode({}).runtime).toBe('worker');
  });
});
