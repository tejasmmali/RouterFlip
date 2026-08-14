/**
 * Argument parsing.
 *
 * Hand-rolled for the same reason as the schema validator: zero runtime
 * dependencies. The design goals are (a) an unknown flag is an error rather than
 * a silent no-op, and (b) everything after `--` is forwarded verbatim, so
 * `routerflip claude -- --resume` reaches Claude Code untouched.
 */
import { RouterFlipError } from './errors.ts';

/** Flags that never take a value. */
const BOOLEAN_FLAGS = [
  'help',
  'version',
  'verbose',
  'quiet',
  'json',
  'yes',
  'force',
  'temporary',
  'permanent',
  'all',
  'no-color',
  'plain',
  'no-test',
  'key-stdin',
] as const;

/** Flags that consume the next token (or use `--flag=value`). */
const VALUE_FLAGS = [
  'name',
  'url',
  'key',
  'description',
  'path',
  'strategy',
  'color',
  'provider',
  'auth-env',
  'router',
  'account',
  'shell',
  'timeout',
] as const;

const ALIASES: Readonly<Record<string, string>> = {
  h: 'help',
  V: 'version',
  v: 'verbose',
  j: 'json',
  y: 'yes',
  t: 'temporary',
  p: 'permanent',
  r: 'router',
  a: 'account',
  n: 'name',
  u: 'url',
  d: 'description',
};

export type FlagValue = string | boolean;

export interface Parsed {
  readonly command: string | undefined;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, FlagValue>>;
  /** Tokens after `--`, forwarded to a child process untouched. */
  readonly rest: readonly string[];
}

function isBoolean(name: string): boolean {
  return (BOOLEAN_FLAGS as readonly string[]).includes(name);
}

function isValue(name: string): boolean {
  return (VALUE_FLAGS as readonly string[]).includes(name);
}

function unknownFlag(token: string): RouterFlipError {
  return new RouterFlipError('BAD_USAGE', `Unknown option "${token}".`, {
    hint: 'Run `routerflip help` to see the available commands and options.',
    exitCode: 2,
  });
}

/**
 * Commands whose remaining arguments belong to a child process.
 *
 * For these, parsing stops at the first token that is not a RouterFlip flag, so
 * `routerflip claude --resume` forwards `--resume` instead of rejecting it.
 */
const PASSTHROUGH_COMMANDS = new Set(['claude', 'run']);

export function parseArgs(argv: readonly string[]): Parsed {
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  const rest: string[] = [];
  let command: string | undefined;
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';

    if (passthrough) {
      rest.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      const inline = eq >= 0 ? body.slice(eq + 1) : undefined;

      if (isBoolean(name)) {
        if (inline !== undefined) {
          flags[name] = inline !== 'false' && inline !== '0';
        } else {
          flags[name] = true;
        }
        continue;
      }
      if (isValue(name)) {
        if (inline !== undefined) {
          flags[name] = inline;
          continue;
        }
        const next = argv[index + 1];
        if (next === undefined || (next.startsWith('-') && next.length > 1)) {
          throw new RouterFlipError('BAD_USAGE', `Option "--${name}" needs a value.`, {
            hint: `Example: --${name} <value>`,
            exitCode: 2,
          });
        }
        flags[name] = next;
        index += 1;
        continue;
      }
      if (command && PASSTHROUGH_COMMANDS.has(command)) {
        rest.push(token);
        passthrough = true;
        continue;
      }
      throw unknownFlag(token);
    }

    if (token.length > 1 && token.startsWith('-')) {
      const letters = token.slice(1);
      // Support `-vy` as well as `-v -y`, and `-r name`.
      for (let position = 0; position < letters.length; position += 1) {
        const letter = letters[position] ?? '';
        const name = ALIASES[letter];
        if (!name) {
          if (command && PASSTHROUGH_COMMANDS.has(command)) {
            rest.push(token);
            passthrough = true;
            break;
          }
          throw unknownFlag(`-${letter}`);
        }
        if (isBoolean(name)) {
          flags[name] = true;
          continue;
        }
        // A value flag consumes the remainder of the cluster, else the next token.
        const remainder = letters.slice(position + 1);
        if (remainder.length > 0) {
          flags[name] = remainder;
          break;
        }
        const next = argv[index + 1];
        if (next === undefined) {
          throw new RouterFlipError('BAD_USAGE', `Option "-${letter}" needs a value.`, { exitCode: 2 });
        }
        flags[name] = next;
        index += 1;
        break;
      }
      continue;
    }

    if (command === undefined) {
      command = token;
      continue;
    }
    if (PASSTHROUGH_COMMANDS.has(command)) {
      rest.push(token);
      passthrough = true;
      continue;
    }
    positionals.push(token);
  }

  return { command, positionals, flags, rest };
}

/** Typed, defaulted access to parsed flags. */
export class Flags {
  readonly #flags: Readonly<Record<string, FlagValue>>;

  constructor(flags: Readonly<Record<string, FlagValue>>) {
    this.#flags = flags;
  }

  bool(name: string): boolean {
    return this.#flags[name] === true;
  }

  str(name: string): string | undefined {
    const value = this.#flags[name];
    return typeof value === 'string' ? value : undefined;
  }

  int(name: string): number | undefined {
    const value = this.str(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new RouterFlipError('BAD_USAGE', `Option "--${name}" must be a number.`, { exitCode: 2 });
    }
    return parsed;
  }

  /** Restricts a flag to a known set of values. */
  choice<T extends string>(name: string, allowed: readonly T[]): T | undefined {
    const value = this.str(name);
    if (value === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(value)) {
      throw new RouterFlipError('BAD_USAGE', `Option "--${name}" must be one of: ${allowed.join(', ')}.`, {
        exitCode: 2,
      });
    }
    return value as T;
  }

  get raw(): Readonly<Record<string, FlagValue>> {
    return this.#flags;
  }
}
