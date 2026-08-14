/**
 * PATH-based executable resolution.
 *
 * Deliberately hand-rolled rather than shelling out to `which`/`where.exe`:
 * spawning a shell to find a program is slower, platform-specific, and would
 * mean building a command string out of a name. This resolves the same way the
 * OS loader does — PATH entries in order, with PATHEXT applied on Windows.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  if (IS_WINDOWS) return true; // PATHEXT membership is what makes it runnable
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExtensions(): string[] {
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const list = raw
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
  return ['', ...list];
}

function candidates(name: string): string[] {
  return IS_WINDOWS ? windowsExtensions().map((ext) => `${name}${ext}`) : [name];
}

/** Absolute path of `name` as the OS would resolve it, or undefined. */
export function which(name: string, pathEnv = process.env.PATH ?? ''): string | undefined {
  if (name.length === 0) return undefined;

  // An explicit path (./claude, /usr/local/bin/claude) bypasses PATH entirely.
  if (name.includes('/') || name.includes('\\') || isAbsolute(name)) {
    for (const candidate of candidates(resolve(name))) {
      if (isExecutableFile(candidate)) return candidate;
    }
    return undefined;
  }

  const dirs = pathEnv.split(delimiter).filter((dir) => dir.length > 0);
  if (IS_WINDOWS) dirs.unshift(process.cwd()); // Windows searches the cwd first

  for (const dir of dirs) {
    const cleaned = dir.replace(/^"(.*)"$/, '$1');
    for (const candidate of candidates(name)) {
      const full = join(cleaned, candidate);
      if (isExecutableFile(full)) return full;
    }
  }
  return undefined;
}

/** First resolvable name from `names`, with the name that matched. */
export function whichAny(names: readonly string[]): { readonly name: string; readonly path: string } | undefined {
  for (const name of names) {
    const found = which(name);
    if (found) return { name, path: found };
  }
  return undefined;
}
