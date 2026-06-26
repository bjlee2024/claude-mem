// Instrument-only telemetry sink. This fork deliberately does NOT send any
// data to an external service. The exported API matches the upstream
// instrumentation surface so worker call sites compile unchanged, but the
// terminal sink is local-only: nothing leaves the machine. No posthog-node
// dependency, no consent file, no network.
import { scrubProperties } from './scrub.js';

let isShutdown = false;

/**
 * Record an instrumentation event. In this fork the event is dropped (or, with
 * CLAUDE_MEM_TELEMETRY_DEBUG=1, printed to stderr for local inspection). The
 * signature mirrors upstream so call sites are portable.
 */
export function captureEvent(
  event: string,
  props?: Record<string, unknown>,
  _opts?: { person?: boolean }
): void {
  try {
    if (isShutdown) return;
    if (process.env.CLAUDE_MEM_TELEMETRY_DEBUG === '1') {
      const properties = scrubProperties({ ...(props ?? {}) });
      // Direct stderr write (not console.*): repo logger standards forbid
      // console.* in background services (tests/logger-usage-standards.test.ts).
      process.stderr.write('[telemetry] ' + JSON.stringify({ event, properties }) + '\n');
    }
    // No-op sink: nothing is sent anywhere.
  } catch {
    // Telemetry must never break the worker. Swallow everything.
  }
}

/** Graceful-shutdown latch. No client to flush; resolves immediately. */
export async function shutdownTelemetry(): Promise<void> {
  isShutdown = true;
}

/** Test-only reset of the process-wide shutdown latch. */
export function __resetTelemetryForTests(): void {
  isShutdown = false;
}
