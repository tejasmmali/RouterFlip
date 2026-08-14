/**
 * Error taxonomy.
 *
 * Every user-facing failure funnels through `RouterFlipError` so the CLI can
 * print a short headline, an actionable hint, and (only with `--verbose`) the
 * underlying technical cause. Raw `ENOENT spawnSync failed` style messages
 * never reach the user directly.
 */

export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_WRITE_FAILED'
  | 'CREDENTIAL_STORE_UNAVAILABLE'
  | 'CREDENTIAL_READ_FAILED'
  | 'CREDENTIAL_WRITE_FAILED'
  | 'CREDENTIAL_MISSING'
  | 'ROUTER_NOT_FOUND'
  | 'ROUTER_DUPLICATE'
  | 'ROUTER_INVALID'
  | 'NO_ROUTERS'
  | 'INVALID_URL'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_CONFIG_FAILED'
  | 'LAUNCH_FAILED'
  | 'NETWORK_FAILED'
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'UNKNOWN_COMMAND'
  | 'BAD_USAGE'
  | 'CANCELLED'
  | 'NOT_INTERACTIVE'
  | 'INTERNAL';

export interface RouterFlipErrorOptions {
  /** Short actionable next step shown under the headline. */
  readonly hint?: string;
  /** Underlying error; surfaced only in verbose mode. */
  readonly cause?: unknown;
  /** Process exit code. Defaults to 1. */
  readonly exitCode?: number;
}

export class RouterFlipError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(code: ErrorCode, message: string, options: RouterFlipErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RouterFlipError';
    this.code = code;
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

/** Thrown when the user aborts a prompt (Esc / Ctrl+C / "Cancel"). */
export class CancelledError extends RouterFlipError {
  constructor(message = 'Cancelled.') {
    super('CANCELLED', message, { exitCode: 130 });
    this.name = 'CancelledError';
  }
}

export function isCancelled(error: unknown): error is CancelledError {
  return error instanceof RouterFlipError && error.code === 'CANCELLED';
}

/** Best-effort extraction of a readable message from an unknown throwable. */
export function describeCause(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${error.message} (${code})` : error.message;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
