import { AuthenticatedClient } from '../api.js';
import {
  bold,
  cyan,
  dim,
  formatDuration,
  formatRelative,
  print,
  printJson,
  yellow,
} from '../output.js';
import { labelFor, type TimerSession } from '../timer.js';
import type { CommandContext } from './types.js';

/**
 * What is tracking right now. The API returns 200 with a null body when
 * nothing is running, so there is no 404 to special-case.
 */
export async function status(context: CommandContext): Promise<number> {
  const client = AuthenticatedClient.load();
  const session = (await client.get('/timer/session')) as TimerSession | null;

  if (context.json) {
    printJson({ running: session !== null, session });
    return 0;
  }

  if (!session) {
    print('Nothing is tracking.');
    print(dim('Start something with: goalslot start "what you are doing"'));
    return 0;
  }

  const state = session.status === 'RUNNING' ? cyan('running') : yellow('paused');
  print(`${bold(labelFor(session))}  ${state}`);
  print(`${dim('Elapsed')}  ${formatDuration(session.elapsedMs)}`);
  print(`${dim('Started')}  ${formatRelative(session.startedAt)}`);

  if (session.status === 'PAUSED' && session.pausedAt) {
    print(`${dim('Paused')}   ${formatRelative(session.pausedAt)}`);
  }
  if (session.goal?.title) print(`${dim('Goal')}     ${session.goal.title}`);
  if (session.scheduleBlock?.title) {
    print(`${dim('Block')}    ${session.scheduleBlock.title}`);
  }
  if (session.notes) print(`${dim('Notes')}    ${session.notes}`);

  if (session.isStale) {
    print();
    print(
      yellow(
        `This session has been open for ${formatDuration(session.elapsedMs)}. ` +
          `Stopping it would log ${formatDuration(session.cappedElapsedMs)}.`,
      ),
    );
  }

  return 0;
}
