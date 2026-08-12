import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { PAUSED_SESSIONS_PATH } from './paths.js';

// Entries older than this are treated as gone. Explicit /claude-mem:resume is
// the only other way to clear an entry — Stop fires every turn, not at session
// end, so it cannot be used as an end-of-session signal here. Without this
// expiry, a session that's never resumed (crash, force-quit, or the user
// forgetting) would stay paused forever and the file would grow without bound.
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

// Scoped by pid so two processes (e.g. two Claude Code windows) racing a
// pause/resume at the same moment never share a temp file. writeFileSync
// truncates then writes; a shared name lets one process's rename land on top
// of the other's half-written content, and a torn file fails JSON.parse and
// reads back as "nothing paused". A per-pid name can't collide, so the rename
// is always atomic for the file it actually targets. The read-modify-write
// lost-update window across processes remains and is accepted for this data.
function write(map: PausedMap): boolean {
  const tmp = `${PAUSED_SESSIONS_PATH}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(PAUSED_SESSIONS_PATH), { recursive: true });
    writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    renameSync(tmp, PAUSED_SESSIONS_PATH);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
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

/**
 * Persists the pause. Returns false if the write failed (e.g. a root-owned
 * state file from an earlier `sudo npx`, a full disk, a read-only $HOME) so
 * the CLI caller can report failure instead of claiming success it didn't
 * achieve.
 */
export function pauseSession(sessionId: string): boolean {
  if (!sessionId) return false;
  const now = Date.now();
  const map = withoutExpired(read(), now);
  map[sessionId] = now;
  return write(map);
}

/** Returns false if the write failed; see pauseSession. */
export function resumeSession(sessionId: string): boolean {
  if (!sessionId) return false;
  const map = withoutExpired(read(), Date.now());
  delete map[sessionId];
  return write(map);
}
