import type { ParsedArgs } from '../args.js';

export interface CommandContext {
  args: ParsedArgs;
  /** --json: machine-readable output, no decoration. */
  json: boolean;
}

/** Resolves to the process exit code. */
export type Command = (context: CommandContext) => Promise<number>;
