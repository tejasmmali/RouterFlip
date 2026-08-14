/**
 * Filesystem helpers with two guarantees the rest of the app relies on:
 *
 *  1. Writes are atomic (write temp + rename), so an interrupted RouterFlip can
 *     never leave a half-written config.json or a truncated settings.json.
 *  2. Files that may contain or reference secrets are created 0600 and their
 *     directories 0700 on POSIX. On Windows, NTFS inherits the user profile ACL,
 *     which is already user-scoped; we document that rather than pretend to set
 *     a mode Windows ignores.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RouterFlipError, describeCause } from '../errors.ts';

const IS_WINDOWS = process.platform === 'win32';
export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

export function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    if (!IS_WINDOWS) chmodSync(dir, DIR_MODE);
  } catch (error) {
    throw new RouterFlipError('CONFIG_WRITE_FAILED', `Could not create directory ${dir}.`, {
      hint: 'Check that you have write permission to your home directory.',
      cause: error,
    });
  }
}

/** Restricts a file to the current user. No-op on Windows (ACL-inherited). */
export function restrictFile(file: string): void {
  if (IS_WINDOWS) return;
  try {
    chmodSync(file, FILE_MODE);
  } catch {
    // Non-fatal: some filesystems (e.g. mounted FAT/exFAT) do not support modes.
  }
}

/**
 * A UTF-8 byte-order mark is common in files written by Windows editors and by
 * PowerShell redirection, and `JSON.parse` rejects it outright. Stripping it in
 * the one place every read goes through keeps callers BOM-agnostic — the
 * alternative is refusing to touch a settings file that Claude Code itself
 * reads happily.
 */
const BOM = String.fromCharCode(0xfeff);

export function readTextIfExists(file: string): string | undefined {
  try {
    const raw = readFileSync(file, 'utf8');
    return raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new RouterFlipError('PERMISSION_DENIED', `Cannot read ${file}.`, {
        hint: 'Check the file permissions and that you own the file.',
        cause: error,
      });
    }
    throw new RouterFlipError('CONFIG_INVALID', `Could not read ${file}.`, { cause: error });
  }
}

/** Atomic, permission-restricted write. */
export function writeTextAtomic(file: string, contents: string): void {
  ensureDir(dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, contents, { encoding: 'utf8', mode: FILE_MODE });
    restrictFile(temp);
    renameSync(temp, file);
    restrictFile(file);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* best effort */
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new RouterFlipError('PERMISSION_DENIED', `Cannot write ${file}.`, {
        hint: 'Check that you have write permission to the file and its folder.',
        cause: error,
      });
    }
    throw new RouterFlipError('CONFIG_WRITE_FAILED', `Could not save ${file}.`, {
      hint: `Details: ${describeCause(error)}`,
      cause: error,
    });
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export interface BackupResult {
  readonly path: string;
  readonly created: boolean;
}

/**
 * Copies `file` into `backupsDir` with a sortable timestamped name.
 * Returns `created: false` when there was nothing to back up.
 */
export function backupFile(file: string, backupsDir: string, label: string): BackupResult {
  if (!existsSync(file)) return { path: '', created: false };
  ensureDir(backupsDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(backupsDir, `${label}-${stamp}.json`);
  try {
    copyFileSync(file, target);
    restrictFile(target);
    return { path: target, created: true };
  } catch (error) {
    throw new RouterFlipError('CONFIG_WRITE_FAILED', `Could not back up ${file}.`, {
      hint: 'RouterFlip refuses to modify configuration it cannot back up first.',
      cause: error,
    });
  }
}

/** Deletes the oldest backups beyond `keep` for a given label. */
export function pruneBackups(backupsDir: string, label: string, keep: number): void {
  if (!existsSync(backupsDir)) return;
  try {
    const entries = readdirSync(backupsDir)
      .filter((name) => name.startsWith(`${label}-`) && name.endsWith('.json'))
      .map((name) => ({ name, path: join(backupsDir, name) }))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries.slice(Math.max(keep, 1))) {
      rmSync(entry.path, { force: true });
    }
  } catch {
    // Pruning is housekeeping; never fail a user action because of it.
  }
}

export function fileMode(file: string): string | undefined {
  try {
    return (statSync(file).mode & 0o777).toString(8).padStart(3, '0');
  } catch {
    return undefined;
  }
}

export { existsSync };
