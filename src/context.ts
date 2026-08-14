/**
 * Per-invocation application context.
 *
 * Built once in `cli.ts` and handed to whichever command runs, so no command has
 * to know how config is loaded, which credential backend won, or how the theme
 * was decided. Construction is lazy where it matters: the credential backend is
 * only resolved the first time a key is actually needed, which keeps `--help`
 * and `list` fast and keeps a broken keyring from breaking unrelated commands.
 */
import { Flags, type Parsed } from './args.ts';
import { loadConfig } from './core/store.ts';
import { RouterService } from './core/routers.ts';
import { COLOR_MODES, type ColorMode, type Config } from './core/schema.ts';
import { Credentials } from './credentials/index.ts';
import { providerFor } from './providers/index.ts';
import type { Provider } from './providers/types.ts';
import { logger } from './logger.ts';
import { createTheme, setTheme } from './ui/theme.ts';

export interface AppContext {
  readonly flags: Flags;
  /** Arguments that were not flags, e.g. the `<name>` in `edit <name>`. */
  readonly positionals: readonly string[];
  /** Tokens after `--`, forwarded to a child process untouched. */
  readonly rest: readonly string[];
  readonly config: Config;
  readonly credentials: Credentials;
  readonly service: RouterService;
  readonly provider: Provider;
  readonly json: boolean;
  readonly assumeYes: boolean;
}

/** Resolves the colour mode from flags first, then config, then autodetection. */
export function resolveColorMode(flags: Flags, config?: Config): ColorMode {
  if (flags.bool('no-color') || flags.bool('plain')) return 'never';
  const explicit = flags.choice('color', COLOR_MODES);
  if (explicit) return explicit;
  return config?.settings.color ?? 'auto';
}

export function createContext(parsed: Parsed): AppContext {
  const flags = new Flags(parsed.flags);
  logger.setVerbose(flags.bool('verbose'));
  logger.quiet = flags.bool('quiet');

  const config = loadConfig();
  setTheme(createTheme(resolveColorMode(flags, config)));

  const credentials = new Credentials(config.settings.credentialBackend);
  const service = new RouterService(credentials, config);
  const provider = providerFor();

  return {
    flags,
    positionals: parsed.positionals,
    rest: parsed.rest,
    config,
    credentials,
    service,
    provider,
    json: flags.bool('json'),
    assumeYes: flags.bool('yes') || flags.bool('force'),
  };
}
