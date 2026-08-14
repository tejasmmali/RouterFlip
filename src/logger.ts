/**
 * Structured internal logging.
 *
 * Two channels:
 *   - debug/trace: suppressed unless `--verbose`, written to stderr so it never
 *     pollutes piped stdout.
 *   - every line passes through `redact()`, so even a careless
 *     `logger.debug(JSON.stringify(router))` cannot print a key.
 *
 * `--verbose` also appends the same redacted lines to `~/.routerflip/routerflip.log`
 * (0600), because "run it again with --verbose and send me the log" is how a bug
 * actually gets reported. ROUTERFLIP_LOG_FILE points that elsewhere, or switches it
 * off entirely with `none`. There is no telemetry and no remote sink.
 */
import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir } from './core/fsx.ts';
import { paths } from './core/paths.ts';
import { redact } from './core/mask.ts';
import { DIM, NO_DIM } from './ui/ansi.ts';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

/** Values of ROUTERFLIP_LOG_FILE that mean "write nothing to disk, ever". */
const DISABLED = new Set(['none', 'off', 'no', '0', 'false']);

class Logger {
  #level: LogLevel = 'info';
  #secrets = new Set<string>();
  #ensured = new Set<string>();
  /** When true, non-essential narration is suppressed (`--quiet`). */
  quiet = false;

  setVerbose(verbose: boolean): void {
    this.#level = verbose ? 'debug' : 'info';
    // Say where the log is going, in the log and on stderr: a debug file the user
    // cannot find is no better than no debug file.
    if (verbose) this.debug(`log file: ${this.logFile ?? 'disabled by ROUTERFLIP_LOG_FILE'}`);
  }

  setLevel(level: LogLevel): void {
    this.#level = level;
  }

  get level(): LogLevel {
    return this.#level;
  }

  get verbose(): boolean {
    return LEVEL_ORDER[this.#level] >= LEVEL_ORDER.debug;
  }

  /**
   * Registers a value that must never appear in output. Called whenever a
   * secret is loaded, so redaction covers keys that do not match the generic
   * secret patterns.
   */
  protect(secret: string | undefined): void {
    if (secret && secret.trim().length >= 6) this.#secrets.add(secret.trim());
  }

  scrub(text: string): string {
    return redact(text, [...this.#secrets]);
  }

  error(message: string): void {
    this.#emit('error', message);
  }
  warn(message: string): void {
    this.#emit('warn', message);
  }
  info(message: string): void {
    this.#emit('info', message);
  }
  debug(message: string): void {
    this.#emit('debug', message);
  }
  trace(message: string): void {
    this.#emit('trace', message);
  }

  /**
   * Where log lines are appended, if anywhere. Resolved per call rather than at
   * construction so `--verbose`, ROUTERFLIP_LOG_FILE and ROUTERFLIP_HOME can all
   * be set after this module loads — which is exactly what tests and the CLI's
   * own flag parsing do.
   */
  get logFile(): string | undefined {
    const configured = process.env.ROUTERFLIP_LOG_FILE?.trim();
    if (configured) return DISABLED.has(configured.toLowerCase()) ? undefined : configured;
    return this.verbose ? paths().logFile : undefined;
  }

  #emit(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.#level]) return;
    const safe = this.scrub(message);
    if (level === 'debug' || level === 'trace') {
      process.stderr.write(`  ${DIM}[${level}] ${safe}${NO_DIM}\n`);
    }
    const file = this.logFile;
    if (file) {
      try {
        if (!this.#ensured.has(file)) {
          ensureDir(dirname(file));
          this.#ensured.add(file);
        }
        appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${safe}\n`, { mode: 0o600 });
      } catch {
        /* logging must never break the command */
      }
    }
  }
}

export const logger = new Logger();
