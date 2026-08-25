import { AuthenticatedClient } from '../api.js';
import {
  bold,
  cyan,
  dim,
  formatDuration,
  minutesSinceMidnight,
  print,
  printJson,
} from '../output.js';
import { labelFor, type TimerSession } from '../timer.js';
import type { CommandContext } from './types.js';

interface ScheduleBlock {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  dayOfWeek: number;
  category: string | null;
  goalId: string | null;
}

interface TodayTotal {
  totalMinutes: number;
  totalHours: string;
  tasksLogged: number;
}

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Today's schedule, what has been logged so far, and whatever is tracking.
 *
 * The three reads are independent, so they go out together. The refresh path
 * in AuthenticatedClient is serialised behind a single promise, which is what
 * makes concurrent calls safe here: the API revokes the whole credential if
 * two rotations race, so fanning out must not mean refreshing twice.
 */
export async function today(context: CommandContext): Promise<number> {
  const client = AuthenticatedClient.load();
  const now = new Date();
  const dayOfWeek = now.getDay();

  const [blocks, total, session] = (await Promise.all([
    client.get(`/schedule/day/${dayOfWeek}`),
    client.get('/time-entries/today'),
    client.get('/timer/session'),
  ])) as [ScheduleBlock[], TodayTotal, TimerSession | null];

  const ordered = [...blocks].sort(
    (a, b) => minutesSinceMidnight(a.startTime) - minutesSinceMidnight(b.startTime),
  );

  if (context.json) {
    printJson({
      date: now.toISOString().slice(0, 10),
      dayOfWeek,
      blocks: ordered,
      logged: total,
      running: session !== null,
      session,
    });
    return 0;
  }

  print(bold(`${DAY_NAMES[dayOfWeek]}, ${now.toLocaleDateString()}`));
  print();

  if (ordered.length === 0) {
    print(dim('Nothing scheduled today.'));
  } else {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    for (const block of ordered) {
      const start = minutesSinceMidnight(block.startTime);
      const end = minutesSinceMidnight(block.endTime);
      const current = nowMinutes >= start && nowMinutes < end;

      const window = `${block.startTime}-${block.endTime}`.padEnd(12);
      const line = `${window}${block.title}`;
      // The marker, not colour alone, distinguishes the current block, so it
      // still reads on a pipe or a NO_COLOR terminal.
      print(current ? `${cyan('>')} ${cyan(line)}` : `  ${line}`);
    }
  }

  print();
  print(
    `${dim('Logged')}   ${formatDuration(total.totalMinutes * 60_000)} ` +
      dim(`across ${total.tasksLogged} ${total.tasksLogged === 1 ? 'entry' : 'entries'}`),
  );

  if (session) {
    print(
      `${dim('Tracking')} ${bold(labelFor(session))} ` +
        dim(`(${formatDuration(session.elapsedMs)})`),
    );
  } else {
    print(`${dim('Tracking')} nothing`);
  }

  return 0;
}
