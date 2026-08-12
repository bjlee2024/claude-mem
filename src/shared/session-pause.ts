import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { PAUSED_SESSIONS_PATH } from './paths.js';

// Entries older than this are treated as gone. The Stop hook clears an entry at
// session end, but a crash or a force-quit never fires it — without an expiry
// the file would grow forever.
const TTL_MS = 24 * 60 * 60 * 1000;

type PausedMap = Record<string, number>;

function read(): PausedMap {
  try {
    const raw = readFileSync(PAUSED_SESSIONS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PausedMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number') out[key] = value;
    }
    return out;
  } catch {
    // Missing file, malformed JSON, unreadable path — all mean "nothing paused".
    return {};
  }
}

function withoutExpired(map: PausedMap, now: number): PausedMap {
  const out: PausedMap = {};
  for (const [key, pausedAt] of Object.entries(map)) {
    if (now - pausedAt < TTL_MS) out[key] = pausedAt;
  }
  return out;
}

function write(map: PausedMap): void {
  const tmp = `${PAUSED_SESSIONS_PATH}.tmp`;
  try {
    mkdirSync(dirname(PAUSED_SESSIONS_PATH), { recursive: true });
    writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    renameSync(tmp, PAUSED_SESSIONS_PATH);
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

/**
 * Whether this session's observation recording is paused.
 *
 * Called from hooks on every tool use, so it must never throw and must not
 * write: a read that fails means "not paused". Silently pausing a session the
 * user never paused would lose their history with no signal.
 */
export function isSessionPaused(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const pausedAt = read()[sessionId];
  if (typeof pausedAt !== 'number') return false;
  return Date.now() - pausedAt < TTL_MS;
}

export function pauseSession(sessionId: string): void {
  if (!sessionId) return;
  const now = Date.now();
  const map = withoutExpired(read(), now);
  map[sessionId] = now;
  write(map);
}

export function resumeSession(sessionId: string): void {
  if (!sessionId) return;
  const map = withoutExpired(read(), Date.now());
  delete map[sessionId];
  write(map);
}
