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
    // Set, not process.exit(): this function must stay callable from tests
    // without killing the test runner. main() in index.ts exits the process
    // once the event loop drains, same as every sibling command's usage error.
    process.exitCode = 1;
    return;
  }

  if (!sessionId || !sessionId.trim()) {
    console.error(pc.red('A session id is required.'));
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const id = sessionId.trim();

  if (sub === 'pause') {
    if (!pauseSession(id)) {
      console.error(pc.red(`Failed to pause session (${id}): could not write pause state.`));
      process.exitCode = 1;
      return;
    }
    console.log(`Observation recording paused for this session (${id}).`);
    console.log('Context injection continues. Already-recorded observations are unaffected.');
    return;
  }

  if (sub === 'resume') {
    if (!resumeSession(id)) {
      console.error(pc.red(`Failed to resume session (${id}): could not write pause state.`));
      process.exitCode = 1;
      return;
    }
    console.log(`Observation recording resumed for this session (${id}).`);
    return;
  }

  console.log(isSessionPaused(id) ? `paused (${id})` : `recording (${id})`);
}
