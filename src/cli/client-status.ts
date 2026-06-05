// SPDX-License-Identifier: Apache-2.0
//
// Client/server split — assembles the thin-client status snapshot from injected
// probes so it can be unit-tested without network or filesystem.
export interface ClientStatusProbes {
  runtime: string;
  serverBaseUrl: string;
  ping: () => Promise<boolean>;
  spoolDepth: () => number;
}
export interface ClientStatus {
  runtime: string;
  server: string;
  reachable: boolean;
  spoolDepth: number;
}
export async function buildClientStatus(p: ClientStatusProbes): Promise<ClientStatus> {
  let reachable = false;
  try { reachable = await p.ping(); } catch { reachable = false; }
  return { runtime: p.runtime, server: p.serverBaseUrl, reachable, spoolDepth: p.spoolDepth() };
}
