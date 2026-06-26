// Local-sink CLI telemetry. Mirrors the upstream captureCliEvent surface — the
// 3-arg signature and the awaitable Promise<void> return that worker-utils.ts
// (commit c0b96288) `await`s — but terminates at the local-only captureEvent
// sink: nothing is sent anywhere. No posthog, no network, no new dependency.
import { captureEvent } from './telemetry.js';

export async function captureCliEvent(
  event: string,
  props?: Record<string, unknown>,
  opts?: { person?: boolean }
): Promise<void> {
  captureEvent(event, props, opts);
}
