import pc from 'picocolors';
import { pauseSession, resumeSession, isSessionPaused } from '../../shared/session-pause.js';

const USAGE = 'Usage: npx @bjlee2024/claude-mem session <pause|resume|status> <sessionId>';

/**
 * Manages per-session observation recording. The session id is passed in rather
 * than read from the environment: this process is not the session it acts on,
 * and the caller (the pause/resume skill) is the one that knows its own id.
 */
export function runSessionCommand(args: string[]): void {
  const [sub, sessionId] = args;

  if (!sub || !['pause', 'resume', 'status'].includes(sub)) {
    console.error(pc.red(`Unknown session command: ${sub ?? '(none)'}`));
    console.error(USAGE);
    return;
  }

  if (!sessionId || !sessionId.trim()) {
    console.error(pc.red('A session id is required.'));
    console.error(USAGE);
    return;
  }

  const id = sessionId.trim();

  if (sub === 'pause') {
    pauseSession(id);
    console.log(`Observation recording paused for this session (${id}).`);
    console.log('Context injection continues. Already-recorded observations are unaffected.');
    return;
  }

  if (sub === 'resume') {
    resumeSession(id);
    console.log(`Observation recording resumed for this session (${id}).`);
    return;
  }

  console.log(isSessionPaused(id) ? `paused (${id})` : `recording (${id})`);
}
