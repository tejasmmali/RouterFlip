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

export function loadConfig(): Config {
  const { configFile } = paths();
  const raw = readTextIfExists(configFile);
  if (raw === undefined || raw.trim().length === 0) return emptyConfig();
  return parseJsonFile<Config>(configFile, raw, (input) => configSchema.safeParse(input));
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
