/**
 * Terminal output. No colour library: a CLI this small does not need a
 * dependency to write four escape codes, and shipping zero runtime deps means
 * `npx goalslot` installs in one tick.
 */

const useColor =
  process.stdout.isTTY === true &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb';

function wrap(code: string, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const bold = (text: string): string => wrap('1', text);
export const dim = (text: string): string => wrap('2', text);
export const green = (text: string): string => wrap('32', text);
export const yellow = (text: string): string => wrap('33', text);
export const red = (text: string): string => wrap('31', text);
export const cyan = (text: string): string => wrap('36', text);

export function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function printError(line: string): void {
  process.stderr.write(`${red('Error')} ${line}\n`);
}

export function printWarning(line: string): void {
  process.stderr.write(`${yellow('Warning')} ${line}\n`);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** 4_920_000 -> "1h 22m". Under a minute reads as seconds so a fresh start is visible. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

/** Minutes as stored on a time entry, rendered the same way. */
export function formatMinutes(minutes: number): string {
  return formatDuration(minutes * 60_000);
}

export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;

  const deltaMs = now.getTime() - then;
  const suffix = deltaMs >= 0 ? 'ago' : 'from now';
  return `${formatDuration(Math.abs(deltaMs))} ${suffix}`;
}

/** "09:00" and a Date in local time, for ordering and highlighting today's blocks. */
export function minutesSinceMidnight(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * 60 + Number(match[2]);
}
