import { AuthenticatedClient, ApiError } from '../api.js';
import {
  bold,
  dim,
  formatDuration,
  green,
  print,
  printJson,
  yellow,
} from '../output.js';
import type { StopResult } from '../timer.js';
import type { CommandContext } from './types.js';

/**
 * Stops the running session and converts it into a time entry. The API does
 * the session delete and the entry write in one transaction, so a double stop
 * produces exactly one entry, not two.
 *
 * `--discard` throws the session away without logging anything, for the
 * accidental start.
 */
export async function stop(context: CommandContext): Promise<number> {
  const { args } = context;
  const client = AuthenticatedClient.load();

  if (args.booleans.discard) {
    const result = (await client.delete('/timer/session')) as { discarded: boolean };
    if (context.json) {
      printJson({ status: 'discarded', ...result });
      return result.discarded ? 0 : 1;
    }
    if (!result.discarded) {
      print('Nothing was tracking.');
      return 1;
    }
    print(`${yellow('Discarded')} ${dim('no time entry was written')}`);
    return 0;
  }

  const body: Record<string, unknown> = {};
  if (args.strings.notes) body.notes = args.strings.notes;

  let result: StopResult;
  try {
    result = (await client.post('/timer/session/stop', body)) as StopResult;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      if (context.json) {
        printJson({ status: 'idle' });
        return 1;
      }
      print('Nothing was tracking.');
      return 1;
    }
    throw error;
  }

  if (context.json) {
    printJson({ status: 'stopped', ...result });
    return 0;
  }

  const label = result.timeEntry.taskName || 'Untitled';
  print(`${green('Logged')} ${formatDuration(result.durationMinutes * 60_000)} ${dim('to')} ${bold(label)}`);

  if (result.capped) {
    print(
      yellow(
        `The session ran for ${formatDuration(result.elapsedMs)}, capped to ` +
          `${formatDuration(result.maxSessionMs)} on the entry.`,
      ),
    );
  }
  return 0;
}
