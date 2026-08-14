/**
 * Claude Code provider.
 *
 * ── How this was determined (spec §26) ────────────────────────────────────────
 * Rather than assume a config layout, the installed `claude` executable was
 * inspected in this environment. It contains, verifiably:
 *
 *   ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
 *   ANTHROPIC_CUSTOM_HEADERS            → environment variables are honoured
 *   settings.env                        → settings.json may carry an env block
 *   apiKeyHelper                        → a command may supply the key instead
 *   .claude/settings.json, settings.local.json, managed-settings.json
 *   CLAUDE_CONFIG_DIR                   → the config directory is overridable
 *
 * Therefore:
 *   temporary mode → process environment only (nothing on disk changes);
 *   permanent mode → patch *only* `env.ANTHROPIC_BASE_URL` plus either
 *                    `env.<authEnvVar>` ('env' strategy) or `apiKeyHelper`
 *                    ('helper' strategy) inside the user-level settings.json,
 *                    after a timestamped backup, preserving every other key.
 *
 * `managed-settings.json` (administrator policy) and `settings.local.json`
 * (project scope) are intentionally never written: the first is not ours to
 * touch, and the second would leak a gateway choice into a repository.
 */
import { existsSync } from 'node:fs';
import { claudeConfigDir, claudeSettingsFile } from '../core/paths.ts';
import { backupFile, pruneBackups, readTextIfExists, writeJsonAtomic } from '../core/fsx.ts';
import { nowIso } from '../core/id.ts';
import { AUTH_ENV_VARS, type Activation, type Router } from '../core/schema.ts';
import { RouterFlipError } from '../errors.ts';
import { logger } from '../logger.ts';
import { run } from '../util/exec.ts';
import { which } from '../util/which.ts';
import type {
  ApplyOptions,
  ApplyResult,
  ClearResult,
  EnvDelta,
  PermanentStrategy,
  Provider,
  ProviderConfigSnapshot,
  ProviderDetection,
} from './types.ts';

const BASE_URL_KEY = 'ANTHROPIC_BASE_URL';
const HELPER_KEY = 'apiKeyHelper';
const ENV_BLOCK = 'env';

type Settings = Record<string, unknown>;

/** Reads settings.json. Never invents content, never repairs invalid JSON. */
function readSettings(file: string): { settings: Settings; existed: boolean } {
  const raw = readTextIfExists(file);
  if (raw === undefined || raw.trim().length === 0) return { settings: {}, existed: raw !== undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RouterFlipError('PROVIDER_CONFIG_FAILED', `${file} is not valid JSON.`, {
      hint: 'RouterFlip will not rewrite a settings file it cannot parse. Fix or move the file, then retry.',
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RouterFlipError('PROVIDER_CONFIG_FAILED', `${file} does not contain a JSON object.`, {
      hint: 'Move the file aside and let Claude Code recreate it, then retry.',
    });
  }
  return { settings: parsed as Settings, existed: true };
}

function envBlock(settings: Settings): Record<string, unknown> {
  const block = settings[ENV_BLOCK];
  return block && typeof block === 'object' && !Array.isArray(block) ? { ...(block as Record<string, unknown>) } : {};
}

/** Dotted-path read limited to the two shapes we manage. */
function readPath(settings: Settings, path: string): unknown {
  if (path.startsWith(`${ENV_BLOCK}.`)) return envBlock(settings)[path.slice(ENV_BLOCK.length + 1)];
  return settings[path];
}

function hasPath(settings: Settings, path: string): boolean {
  return readPath(settings, path) !== undefined;
}

function stringAt(settings: Settings, path: string): string | undefined {
  const value = readPath(settings, path);
  return typeof value === 'string' ? value : undefined;
}

class ClaudeCodeProvider implements Provider {
  readonly id = 'claude-code' as const;
  readonly label = 'Claude Code';
  readonly commands = ['claude'] as const;
  readonly mechanism =
    'Environment variables for temporary mode; env.ANTHROPIC_BASE_URL plus an auth entry in settings.json for permanent mode.';

  async detect(): Promise<ProviderDetection> {
    const executable = which('claude');
    if (!executable) {
      return {
        found: false,
        hint: 'Claude Code was not found on your PATH. Install it from https://claude.com/claude-code — RouterFlip never installs it for you.',
      };
    }
    // `--version` is cheap and side-effect free; a failure is not fatal.
    const result = await run(executable, ['--version'], { timeoutMs: 6_000 });
    const version = result.spawnError ? undefined : result.stdout.trim().split('\n')[0]?.trim();
    return {
      found: true,
      executable,
      command: 'claude',
      ...(version && version.length > 0 ? { version } : {}),
    };
  }

  envFor(router: Router, apiKey: string): EnvDelta {
    return { [BASE_URL_KEY]: router.baseUrl, [router.authEnvVar]: apiKey };
  }

  conflicts(router: Router): readonly string[] {
    // Leaving the other auth variable set would let an old key win.
    return AUTH_ENV_VARS.filter((name) => name !== router.authEnvVar);
  }

  envKeys(router: Router): readonly string[] {
    return [BASE_URL_KEY, router.authEnvVar];
  }

  configFile(): string {
    return claudeSettingsFile();
  }

  inspect(): ProviderConfigSnapshot {
    const file = this.configFile();
    if (!existsSync(file)) {
      return { file, exists: false, hasAuth: false, otherEnvKeys: [], preservedKeys: [] };
    }
    const { settings } = readSettings(file);
    const env = envBlock(settings);
    const authEnvVar = AUTH_ENV_VARS.find((name) => typeof env[name] === 'string' && (env[name] as string).length > 0);
    const helper = typeof settings[HELPER_KEY] === 'string' ? (settings[HELPER_KEY] as string) : undefined;
    const baseUrl = typeof env[BASE_URL_KEY] === 'string' ? (env[BASE_URL_KEY] as string) : undefined;
    return {
      file,
      exists: true,
      ...(baseUrl ? { baseUrl } : {}),
      ...(authEnvVar ? { authEnvVar } : {}),
      hasAuth: Boolean(authEnvVar) || Boolean(helper && helper.length > 0),
      otherEnvKeys: Object.keys(env).filter((key) => key !== BASE_URL_KEY && !AUTH_ENV_VARS.includes(key as never)),
      preservedKeys: Object.keys(settings).filter((key) => key !== ENV_BLOCK && key !== HELPER_KEY),
    };
  }

  /** Command written to `apiKeyHelper`, or undefined when unavailable. */
  helperCommand(router: Router): string | undefined {
    const executable = which('routerflip') ?? which('rflip');
    if (!executable) return undefined;
    // Quoted so a path containing spaces still parses as one argument.
    return `"${executable}" credential ${router.id}`;
  }

  applyPermanent(router: Router, apiKey: string, options: ApplyOptions): ApplyResult {
    const file = this.configFile();
    const { settings, existed } = readSettings(file);
    const before = { settings, env: envBlock(settings) };

    let strategy: PermanentStrategy = options.strategy ?? 'env';
    let helper: string | undefined;
    if (strategy === 'helper') {
      helper = this.helperCommand(router);
      if (!helper) strategy = 'env'; // documented fallback; caller reports it
    }

    const authPath = strategy === 'helper' ? HELPER_KEY : `${ENV_BLOCK}.${router.authEnvVar}`;
    const managedKeys = [`${ENV_BLOCK}.${BASE_URL_KEY}`, authPath];

    // Whether a key predates RouterFlip is decided once, on the first apply, and
    // then carried forward — after our own write the answer would always be yes.
    const preexisting: Record<string, string> = { ...(options.previous?.preexisting ?? {}) };
    for (const path of managedKeys) {
      if (preexisting[path] === undefined) preexisting[path] = hasPath(before.settings, path) ? 'yes' : 'no';
    }

    const backup = backupFile(file, options.backupsDir, 'claude-settings');
    pruneBackups(options.backupsDir, 'claude-settings', options.backupRetention ?? 20);

    const nextEnv: Record<string, unknown> = { ...before.env, [BASE_URL_KEY]: router.baseUrl };
    const next: Settings = { ...before.settings };

    if (strategy === 'helper' && helper) {
      next[HELPER_KEY] = helper;
      // The key must not linger in plaintext once a helper supplies it.
      for (const name of AUTH_ENV_VARS) {
        if (preexisting[`${ENV_BLOCK}.${name}`] !== 'yes') delete nextEnv[name];
      }
    } else {
      nextEnv[router.authEnvVar] = apiKey;
      logger.protect(apiKey);
      // Switching auth variable: drop the one we previously added ourselves.
      for (const name of AUTH_ENV_VARS) {
        if (name !== router.authEnvVar && preexisting[`${ENV_BLOCK}.${name}`] === 'no') delete nextEnv[name];
      }
      if (options.previous?.managedKeys.includes(HELPER_KEY) && preexisting[HELPER_KEY] === 'no') {
        delete next[HELPER_KEY];
      }
    }

    next[ENV_BLOCK] = nextEnv;
    writeJsonAtomic(file, next);
    logger.debug(`claude settings patched (${strategy}): ${file}`);

    const originBackup = options.previous?.originBackup ?? (backup.created ? backup.path : undefined);
    return {
      targetFile: file,
      managedKeys,
      preexisting,
      ...(backup.created ? { backup: backup.path } : {}),
      ...(originBackup ? { originBackup } : {}),
      preservedKeys: existed
        ? Object.keys(before.settings).filter((key) => key !== ENV_BLOCK && key !== HELPER_KEY)
        : [],
      strategy,
    };
  }

  clearPermanent(activation: Activation, options: { backupsDir: string }): ClearResult {
    const file = activation.targetFile || this.configFile();
    if (!existsSync(file)) {
      return { targetFile: file, removedKeys: [], changed: false };
    }
    const { settings } = readSettings(file);
    const env = envBlock(settings);
    const next: Settings = { ...settings };
    const removed: string[] = [];

    // Values that predate RouterFlip come back from the earliest backup, so no
    // secret ever has to be kept in state.json to make this reversible.
    const origin = activation.originBackup ? restoreSource(activation.originBackup) : undefined;

    for (const path of activation.managedKeys) {
      const wasThere = activation.preexisting[path] === 'yes';
      const originalValue = origin ? readPath(origin, path) : undefined;
      if (wasThere && originalValue !== undefined) {
        if (path.startsWith(`${ENV_BLOCK}.`)) env[path.slice(ENV_BLOCK.length + 1)] = originalValue;
        else next[path] = originalValue;
      } else if (path.startsWith(`${ENV_BLOCK}.`)) {
        const name = path.slice(ENV_BLOCK.length + 1);
        if (name in env) {
          delete env[name];
          removed.push(path);
        }
      } else if (path in next) {
        delete next[path];
        removed.push(path);
      }
    }

    backupFile(file, options.backupsDir, 'claude-settings');
    if (Object.keys(env).length > 0) next[ENV_BLOCK] = env;
    else delete next[ENV_BLOCK];
    writeJsonAtomic(file, next);
    logger.debug(`claude settings restored: ${file}`);

    return {
      targetFile: file,
      ...(activation.originBackup ? { restoredFrom: activation.originBackup } : {}),
      removedKeys: removed,
      changed: true,
    };
  }
}

/** Loads a backup file for value recovery. Missing/broken backups are ignored. */
function restoreSource(backupPath: string): Settings | undefined {
  const raw = readTextIfExists(backupPath);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Settings;
  } catch {
    /* a corrupt backup simply means "cannot restore a previous value" */
  }
  return undefined;
}

export const claudeCode: Provider = new ClaudeCodeProvider();

/** Descriptive record of what an activation touched. Used by `status`/`doctor`. */
export function activationFrom(router: Router, result: ApplyResult): Activation {
  return {
    routerId: router.id,
    routerName: router.name,
    provider: router.provider,
    appliedAt: nowIso(),
    targetFile: result.targetFile,
    managedKeys: [...result.managedKeys],
    preexisting: result.preexisting,
    ...(result.originBackup ? { originBackup: result.originBackup } : {}),
    ...(result.backup ? { lastBackup: result.backup } : {}),
  };
}

export { claudeConfigDir };
