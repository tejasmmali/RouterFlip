/**
 * Filesystem locations.
 *
 * RouterFlip keeps its own state strictly separate from Claude Code's own
 * configuration directory. Both roots are overridable so tests never touch a
 * developer's real files.
 *
 *   ROUTERFLIP_HOME    -> RouterFlip profile state       (default ~/.routerflip)
 *   CLAUDE_CONFIG_DIR  -> Claude Code configuration dir  (default ~/.claude)
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Paths {
  readonly home: string;
  readonly configFile: string;
  readonly stateFile: string;
  readonly backupsDir: string;
  readonly credentialsFile: string;
  readonly keyFile: string;
  readonly logFile: string;
}

function envDir(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? resolve(value.trim()) : undefined;
}

export function routerFlipHome(): string {
  return envDir('ROUTERFLIP_HOME') ?? join(homedir(), '.routerflip');
}

export function paths(): Paths {
  const home = routerFlipHome();
  return {
    home,
    configFile: join(home, 'config.json'),
    stateFile: join(home, 'state.json'),
    backupsDir: join(home, 'backups'),
    credentialsFile: join(home, 'credentials.enc.json'),
    keyFile: join(home, 'credentials.key'),
    logFile: join(home, 'routerflip.log'),
  };
}

/**
 * Claude Code's configuration directory. Claude Code itself honours
 * CLAUDE_CONFIG_DIR, so we follow the same rule rather than hardcoding
 * `~/.claude` — otherwise we would write settings the CLI never reads.
 */
export function claudeConfigDir(): string {
  return envDir('CLAUDE_CONFIG_DIR') ?? join(homedir(), '.claude');
}

export function claudeSettingsFile(): string {
  return join(claudeConfigDir(), 'settings.json');
}
