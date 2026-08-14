/**
 * config.json and state.json persistence.
 *
 * Reads are forgiving (missing file = defaults, unknown keys dropped) but never
 * silently destructive: a config.json that exists and is corrupt raises an error
 * with the file path instead of being overwritten with defaults.
 */
import { paths } from './paths.ts';
import { backupFile, pruneBackups, readTextIfExists, writeJsonAtomic, ensureDir } from './fsx.ts';
import { configSchema, emptyConfig, emptyState, stateSchema, type Config, type State } from './schema.ts';
import { migrateConfig } from './migrate.ts';
import { formatIssues } from './validate.ts';
import { RouterFlipError } from '../errors.ts';

function parseJsonFile<T>(
  file: string,
  raw: string,
  parse: (input: unknown) => ReturnType<typeof configSchema.safeParse> | ReturnType<typeof stateSchema.safeParse>,
): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new RouterFlipError('CONFIG_INVALID', `${file} is not valid JSON.`, {
      hint: 'Fix the file by hand, or move it aside and RouterFlip will recreate it.',
      cause: error,
    });
  }
  const result = parse(json);
  if (!result.ok) {
    throw new RouterFlipError('CONFIG_INVALID', `${file} has invalid contents:\n${formatIssues(result.issues)}`, {
      hint: 'Fix the listed fields, or move the file aside to start fresh.',
    });
  }
  return result.value as T;
}

/**
 * Reads config.json, migrating it forward if it predates the current version.
 *
 * The migrated result is written back only when something actually changed, so
 * reading is still read-only on an up-to-date file and on a machine with no
 * config.json at all. The write goes through `saveConfig`, which means the
 * pre-migration file is preserved as a timestamped backup for free.
 */
export function loadConfig(): Config {
  const { configFile } = paths();
  const raw = readTextIfExists(configFile);
  if (raw === undefined || raw.trim().length === 0) return emptyConfig();
  const parsed = parseJsonFile<Config>(configFile, raw, (input) => configSchema.safeParse(input));
  const migrated = migrateConfig(parsed);
  if (migrated.changed) saveConfig(migrated.config);
  return migrated.config;
}

export function saveConfig(config: Config): void {
  const { configFile, backupsDir, home } = paths();
  ensureDir(home);
  backupFile(configFile, backupsDir, 'config');
  pruneBackups(backupsDir, 'config', config.settings.backupRetention);
  writeJsonAtomic(configFile, config);
}

export function loadState(): State {
  const { stateFile } = paths();
  const raw = readTextIfExists(stateFile);
  if (raw === undefined || raw.trim().length === 0) return emptyState();
  try {
    return parseJsonFile<State>(stateFile, raw, (input) => stateSchema.safeParse(input));
  } catch (error) {
    // state.json is derived data. A corrupt one should not brick the CLI the way
    // a corrupt config.json would, so we reset it and carry on.
    if (error instanceof RouterFlipError && error.code === 'CONFIG_INVALID') return emptyState();
    throw error;
  }
}

export function saveState(state: State): void {
  const { stateFile, home } = paths();
  ensureDir(home);
  writeJsonAtomic(stateFile, state);
}

export function updateState(mutate: (state: State) => State): State {
  const next = mutate(loadState());
  saveState(next);
  return next;
}

/** True when RouterFlip has never been set up on this machine. */
export function isFirstRun(): boolean {
  return readTextIfExists(paths().configFile) === undefined;
}
