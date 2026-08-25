import { describe, expect, it } from 'vitest';
import { ArgError, flag, parseArgs, type ArgSpec } from '../src/args.js';

const SPEC: ArgSpec = {
  booleans: ['json', 'device', 'take-over', 'help'],
  strings: ['notes', 'api-url'],
  aliases: { h: 'help' },
};

describe('parseArgs', () => {
  it('pulls the command off the front and keeps the rest as positionals', () => {
    const args = parseArgs(['start', 'write', 'the', 'readme'], SPEC);
    expect(args.command).toBe('start');
    expect(args.positionals).toEqual(['write', 'the', 'readme']);
  });

  it('returns a null command when there is nothing but flags', () => {
    expect(parseArgs(['--json'], SPEC).command).toBeNull();
  });

  it('sets a boolean flag', () => {
    expect(parseArgs(['login', '--device'], SPEC).booleans.device).toBe(true);
  });

  it('supports --no-<flag> to force a boolean false', () => {
    expect(parseArgs(['login', '--no-device'], SPEC).booleans.device).toBe(false);
  });

  it('distinguishes an unset boolean from an explicit false', () => {
    // login relies on this: unset means "fall back if headless", false means
    // "never fall back", and they must not collapse into one another.
    expect(parseArgs(['login'], SPEC).booleans.device).toBeUndefined();
    expect(parseArgs(['login', '--no-device'], SPEC).booleans.device).toBe(false);
  });

  it('reads --key=value and --key value the same way', () => {
    expect(parseArgs(['stop', '--notes=done'], SPEC).strings.notes).toBe('done');
    expect(parseArgs(['stop', '--notes', 'done'], SPEC).strings.notes).toBe('done');
  });

  it('keeps a value containing an equals sign intact', () => {
    expect(parseArgs(['stop', '--notes=a=b'], SPEC).strings.notes).toBe('a=b');
  });

  it('resolves aliases to the canonical name', () => {
    expect(parseArgs(['start', '-h'], SPEC).booleans.help).toBe(true);
  });

  it('handles a hyphenated flag name', () => {
    expect(parseArgs(['start', 'x', '--take-over'], SPEC).booleans['take-over']).toBe(true);
  });

  it('treats everything after -- as a positional', () => {
    const args = parseArgs(['start', '--', '--json', '-x'], SPEC);
    expect(args.positionals).toEqual(['--json', '-x']);
    expect(args.booleans.json).toBeUndefined();
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['login', '--devcie'], SPEC)).toThrow(ArgError);
  });

  it('rejects a string flag with no value', () => {
    expect(() => parseArgs(['stop', '--notes'], SPEC)).toThrow(ArgError);
  });

  it('refuses to swallow the next flag as a value', () => {
    // `goalslot stop --notes --json` is a forgotten value, not a note of "--json".
    expect(() => parseArgs(['stop', '--notes', '--json'], SPEC)).toThrow(ArgError);
  });

  it('rejects a value handed to a boolean flag', () => {
    expect(() => parseArgs(['login', '--device=maybe'], SPEC)).toThrow(ArgError);
  });

  it('accepts an explicit --flag=true or false', () => {
    expect(parseArgs(['login', '--device=false'], SPEC).booleans.device).toBe(false);
    expect(parseArgs(['login', '--device=true'], SPEC).booleans.device).toBe(true);
  });

  it('treats a bare dash as a positional', () => {
    expect(parseArgs(['start', '-'], SPEC).positionals).toEqual(['-']);
  });

  it('does not mistake a negative-looking value for a flag when inline', () => {
    expect(parseArgs(['stop', '--notes=-5'], SPEC).strings.notes).toBe('-5');
  });
});

describe('flag', () => {
  it('falls back when the flag was never set', () => {
    const args = parseArgs(['status'], SPEC);
    expect(flag(args, 'json')).toBe(false);
    expect(flag(args, 'json', true)).toBe(true);
  });

  it('prefers an explicit false over the fallback', () => {
    const args = parseArgs(['login', '--no-device'], SPEC);
    expect(flag(args, 'device', true)).toBe(false);
  });
});
