import { ApiError, AuthenticatedClient } from '../api.js';
import {
  bold,
  cyan,
  dim,
  formatDuration,
  print,
  printJson,
  yellow,
} from '../output.js';
import { labelFor, type TimerSession } from '../timer.js';
import type { CommandContext } from './types.js';

/**
 * `goalslot start <task...>`
 *
 * The task name is joined from the remaining positionals so both
 * `goalslot start "write the readme"` and `goalslot start write the readme`
 * work without the user thinking about quoting.
 */
export async function start(context: CommandContext): Promise<number> {
  const { args } = context;
  const taskName = args.positionals.join(' ').trim();

  if (!taskName) {
    throw new Error('Give the timer something to track: goalslot start "write the readme"');
  }
  if (taskName.length > 500) {
    throw new Error('That task name is longer than 500 characters.');
  }

  const client = AuthenticatedClient.load();

  const body: Record<string, unknown> = { taskName };
  if (args.strings.notes) body.notes = args.strings.notes;
  if (args.strings.goal) body.goalId = args.strings.goal;
  if (args.booleans['take-over']) body.takeOver = true;

  let session: TimerSession;
  try {
    session = (await client.post('/timer/session', body)) as TimerSession;
  } catch (error) {
    // 409 carries the session already running. Report it rather than
    // silently replacing work the user may still want logged.
    if (error instanceof ApiError && error.status === 409) {
      return reportConflict(context, error);
    }
    throw error;
  }

  if (context.json) {
    printJson({ status: 'started', session });
    return 0;
  }

  print(`${cyan('Tracking')} ${bold(labelFor(session))}`);
  if (session.notes) print(dim(session.notes));
  return 0;
}

function reportConflict(context: CommandContext, error: ApiError): number {
  const body = error.body as { activeSession?: TimerSession } | null;
  const active = body?.activeSession ?? null;

  if (context.json) {
    printJson({ status: 'conflict', message: error.message, activeSession: active });
    return 1;
  }

  if (active) {
    print(
      yellow('Already tracking ') +
        bold(labelFor(active)) +
        dim(` (${formatDuration(active.elapsedMs)})`),
    );
  } else {
    print(yellow(error.message));
  }
  print();
  print(`Stop it first:   ${bold('goalslot stop')}`);
  print(`Or replace it:   ${bold('goalslot start "..." --take-over')} ${dim('(discards the elapsed time)')}`);
  return 1;
}
