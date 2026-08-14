/**
 * Printing helpers.
 *
 * All human output goes through here so that (a) redaction is centralised and
 * (b) machine-readable output (`--json`) can be routed to stdout while status
 * chatter goes to stderr. Rule of thumb: data on stdout, narration on stderr.
 */
import { logger } from '../logger.ts';
import { iconFail, iconInfo, iconOk, iconWarn } from './icons.ts';
import { theme } from './theme.ts';
import { paragraph } from './box.ts';
import { terminalWidth } from './width.ts';
import { RouterFlipError } from '../errors.ts';

export function write(text: string): void {
  process.stdout.write(logger.scrub(text));
}

export function line(text = ''): void {
  write(`${text}\n`);
}

export function lines(items: readonly string[]): void {
  if (items.length > 0) write(`${items.join('\n')}\n`);
}

export function blank(): void {
  write('\n');
}

/** Narration on stderr. Suppressed by `--quiet`. */
export function note(text: string): void {
  if (logger.quiet) return;
  process.stderr.write(logger.scrub(`${text}\n`));
}

export function success(text: string): void {
  line(`${iconOk()} ${text}`);
}

export function failure(text: string): void {
  line(`${iconFail()} ${theme().error(text)}`);
}

export function warning(text: string): void {
  line(`${iconWarn()} ${theme().warning(text)}`);
}

export function info(text: string): void {
  line(`${iconInfo()} ${text}`);
}

export function heading(text: string): void {
  const t = theme();
  line(t.bold(t.accent(text)));
}

/** `Label:` on one line, value on the next — the spec's layout for details. */
export function field(label: string, value: string, indent = 0): void {
  const t = theme();
  const prefix = ' '.repeat(indent);
  line(`${prefix}${t.muted(`${label}:`)}`);
  line(`${prefix}${value}`);
}

export function json(value: unknown): void {
  // Deliberately not scrubbed through `redact`: --json output is built from
  // already-masked view models, and mangling valid JSON would be worse.
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Renders an error the way the spec asks: a headline, a hint, and technical
 * detail only under --verbose.
 */
export function printError(error: unknown): void {
  const t = theme();
  const width = terminalWidth();
  blank();
  if (error instanceof RouterFlipError) {
    process.stderr.write(logger.scrub(`${iconFail()} ${t.error(error.message)}\n`));
    if (error.hint) {
      process.stderr.write('\n');
      process.stderr.write(logger.scrub(`${paragraph(error.hint, width).join('\n')}\n`));
    }
    if (logger.verbose && error.cause !== undefined) {
      process.stderr.write('\n');
      const detail = error.cause instanceof Error ? (error.cause.stack ?? error.cause.message) : String(error.cause);
      process.stderr.write(logger.scrub(t.dim(`${detail}\n`)));
    } else if (error.cause !== undefined) {
      process.stderr.write('\n');
      process.stderr.write(t.dim('  Run again with --verbose for technical details.\n'));
    }
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(logger.scrub(`${iconFail()} ${t.error('RouterFlip hit an unexpected problem.')}\n`));
    process.stderr.write('\n');
    process.stderr.write(logger.scrub(`${paragraph(message, width).join('\n')}\n`));
    if (logger.verbose && error instanceof Error && error.stack) {
      process.stderr.write(logger.scrub(t.dim(`\n${error.stack}\n`)));
    } else {
      process.stderr.write(t.dim('\n  Run again with --verbose for technical details.\n'));
    }
  }
  process.stderr.write('\n');
}
