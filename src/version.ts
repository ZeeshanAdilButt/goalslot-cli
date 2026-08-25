/**
 * Kept as a literal rather than read from package.json at runtime, because
 * resolving package.json from a bin script has to cope with npx layouts,
 * global installs and bundlers. Bumping this alongside package.json is the
 * cheaper trade.
 */
export const CLI_NAME = 'goalslot-cli';
export const CLI_VERSION = '0.1.0';
