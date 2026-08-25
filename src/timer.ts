/**
 * Shapes returned by the API's singular active-timer resource
 * (`/api/timer/session`). Only the fields the CLI renders are declared; the
 * API returns more and extra keys are ignored on purpose so a server-side
 * addition never breaks the CLI.
 */

export interface NamedRef {
  id: string;
  title?: string | null;
  name?: string | null;
}

export interface TimerSession {
  id: string;
  status: 'RUNNING' | 'PAUSED';
  startedAt: string;
  pausedAt: string | null;
  /** Server-computed, so every client agrees regardless of local clock skew. */
  elapsedMs: number;
  serverTime: string;
  isStale: boolean;
  cappedElapsedMs: number;
  taskName: string | null;
  notes: string | null;
  goalId: string | null;
  goal: NamedRef | null;
  taskId: string | null;
  task: NamedRef | null;
  scheduleBlockId: string | null;
  scheduleBlock: NamedRef | null;
}

export interface StopResult {
  timeEntry: { id: string; taskName?: string | null; duration: number };
  elapsedMs: number;
  durationMinutes: number;
  capped: boolean;
  maxSessionMs: number;
}

export function labelFor(session: TimerSession): string {
  return (
    session.taskName ||
    session.task?.title ||
    session.scheduleBlock?.title ||
    session.goal?.title ||
    'Untitled'
  );
}
