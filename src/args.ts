/**
 * A small argv parser. Deliberately not a framework: the whole surface is
 * seven commands and a handful of flags, and a schema-driven parser is the
 * part that actually needs testing.
 *
 * Supported forms:
 *   --flag                boolean, true
 *   --no-flag             boolean, false
 *   --key value           string, when `key` is declared in `strings`
 *   --key=value           string
 *   -k                    alias, resolved via `aliases`
 *   --                    everything after this is a positional
 *
 * Unknown flags are an error rather than a silent no-op, because a typo in
 * `--devcie` on a login command should not quietly run the browser flow.
 */

export interface ArgSpec {
  /** Flags that take no value. */
  booleans?: readonly string[];
  /** Flags that require a value. */
  strings?: readonly string[];
  /** Short or alternative name to canonical name. */
  aliases?: Readonly<Record<string, string>>;
}

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  booleans: Record<string, boolean>;
  strings: Record<string, string>;
}

export class ArgError extends Error {}

function canonical(name: string, spec: ArgSpec): string {
  return spec.aliases?.[name] ?? name;
}

export function parseArgs(argv: readonly string[], spec: ArgSpec = {}): ParsedArgs {
  const booleans = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);

  const result: ParsedArgs = {
    command: null,
    positionals: [],
    booleans: {},
    strings: {},
  };

  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;

    if (onlyPositionals) {
      result.positionals.push(arg);
      continue;
    }

    if (arg === '--') {
      onlyPositionals = true;
      continue;
    }

    // A bare "-" is a positional by convention (stdin), not a flag.
    if (!arg.startsWith('-') || arg === '-') {
      result.positionals.push(arg);
      continue;
    }

    const isLong = arg.startsWith('--');
    const body = isLong ? arg.slice(2) : arg.slice(1);
    if (body.length === 0) {
      throw new ArgError(`Unknown option: ${arg}`);
    }

    const eq = body.indexOf('=');
    const rawName = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? null : body.slice(eq + 1);

    // --no-foo only makes sense as a long form and only for booleans.
    if (isLong && inlineValue === null && rawName.startsWith('no-')) {
      const negated = canonical(rawName.slice(3), spec);
      if (booleans.has(negated)) {
        result.booleans[negated] = false;
        continue;
      }
    }

    const name = canonical(rawName, spec);

    if (booleans.has(name)) {
      if (inlineValue !== null) {
        if (inlineValue === 'true' || inlineValue === 'false') {
          result.booleans[name] = inlineValue === 'true';
          continue;
        }
        throw new ArgError(`Option --${rawName} does not take a value`);
      }
      result.booleans[name] = true;
      continue;
    }

    if (strings.has(name)) {
      if (inlineValue !== null) {
        if (inlineValue.length === 0) {
          throw new ArgError(`Option --${rawName} needs a value`);
        }
        result.strings[name] = inlineValue;
        continue;
      }
      const next = argv[i + 1];
      // A value that looks like a flag is almost always a forgotten value,
      // so refuse it rather than swallowing the next option.
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new ArgError(`Option --${rawName} needs a value`);
      }
      result.strings[name] = next;
      i += 1;
      continue;
    }

    throw new ArgError(`Unknown option: ${arg}`);
  }

  if (result.positionals.length > 0) {
    result.command = result.positionals[0] as string;
    result.positionals = result.positionals.slice(1);
  }

  return result;
}

/** Boolean flag lookup with a default, so callers do not repeat `?? false`. */
export function flag(args: ParsedArgs, name: string, fallback = false): boolean {
  return args.booleans[name] ?? fallback;
}
