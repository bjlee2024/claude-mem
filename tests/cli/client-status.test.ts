// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { buildClientStatus } from '../../src/cli/client-status.js';

describe('buildClientStatus', () => {
  it('reports runtime, reachability, and spool depth', async () => {
    const s = await buildClientStatus({ runtime: 'client', serverBaseUrl: 'http://h:1', ping: async () => true, spoolDepth: () => 3 });
    expect(s).toEqual({ runtime: 'client', server: 'http://h:1', reachable: true, spoolDepth: 3 });
  });
  it('treats a thrown/failed ping as not reachable', async () => {
    const s = await buildClientStatus({ runtime: 'client', serverBaseUrl: 'http://h:1', ping: async () => { throw new Error('down'); }, spoolDepth: () => 0 });
    expect(s.reachable).toBe(false);
    expect(s.spoolDepth).toBe(0);
  });
});
