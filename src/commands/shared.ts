/**
 * Helpers shared by the commands.
 *
 * Two themes: turning flags into values (so every command accepts the same
 * `--name/--url/--key` shorthands), and asking the user something in a way that
 * still works when there is no terminal — a scripted `routerflip delete x --yes`
 * must never block on a prompt, and without `--yes` it must refuse rather than
 * guess.
 */
import { RouterFlipError } from '../errors.ts';
import type { AppContext } from '../context.ts';
import type { Router } from '../core/schema.ts';
import type { RouterView } from '../core/routers.ts';
import { isInteractive } from '../ui/input.ts';
import { confirm, select, type SelectOption } from '../ui/prompts.ts';
import { logger } from '../logger.ts';

/** Commands return an exit code, or nothing for success. */
export type CommandResult = number | void;

/** The `<name>` argument, however the user chose to pass it. */
export function routerArg(ctx: AppContext, index = 0): string | undefined {
  return ctx.flags.str('router') ?? ctx.positionals[index] ?? ctx.flags.str('name');
}

/** Reads a secret from stdin, for `--key-stdin` in scripts and CI. */
export async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk as string);
  return chunks.join('');
}

/**
 * The API key supplied on the command line, if any.
 *
 * `--key-stdin` is offered because a key on the command line lands in the shell
 * history and in the process table, where other users can read it.
 */
export async function keyFromFlags(ctx: AppContext): Promise<string | undefined> {
  if (ctx.flags.bool('key-stdin')) {
    const value = (await readStdin()).trim();
    if (value.length === 0) {
      throw new RouterFlipError('BAD_USAGE', 'No API key arrived on stdin.', {
        hint: 'Example: `printf %s "$MY_KEY" | routerflip add --name Foo --url https://… --key-stdin`',
        exitCode: 2,
      });
    }
    logger.protect(value);
    return value;
  }
  const inline = ctx.flags.str('key');
  if (inline === undefined) return undefined;
  const value = inline.trim();
  if (value.length === 0) {
    throw new RouterFlipError('BAD_USAGE', 'Option "--key" needs a value.', { exitCode: 2 });
  }
  logger.protect(value);
  return value;
}

export interface ConfirmOptions {
  readonly message: string;
  readonly details?: readonly string[];
  readonly confirmLabel?: string;
  readonly danger?: boolean;
  /** Flag name to mention when confirmation is impossible. Defaults to --yes. */
  readonly flagHint?: string;
}

/**
 * Asks for confirmation. `--yes` answers yes; a non-interactive shell without
 * `--yes` is an error, never an implicit yes — deleting a router because stdin
 * happened to be a pipe would be exactly the wrong default.
 */
export async function confirmAction(ctx: AppContext, options: ConfirmOptions): Promise<boolean> {
  if (ctx.assumeYes) return true;
  if (!isInteractive()) {
    throw new RouterFlipError('NOT_INTERACTIVE', `${options.message} — but there is no terminal to confirm on.`, {
      hint: `Re-run with ${options.flagHint ?? '--yes'} to confirm without a prompt.`,
      exitCode: 2,
    });
  }
  return confirm({
    message: options.message,
    ...(options.details ? { details: options.details } : {}),
    ...(options.confirmLabel ? { confirmLabel: options.confirmLabel } : {}),
    ...(options.danger ? { danger: true } : {}),
  });
}

function routerOptions(views: readonly RouterView[]): SelectOption<string>[] {
  return views.map((view) => ({
    label: view.name,
    value: view.id,
    detail: view.baseUrl,
    ...(view.isActive ? { hint: '(current)' } : {}),
  }));
}

/**
 * Resolves the router a command should act on: the named one when given,
 * otherwise an interactive picker, otherwise a usage error.
 */
export async function pickRouter(ctx: AppContext, message = 'Select a router'): Promise<Router> {
  const named = routerArg(ctx);
  if (named !== undefined) return ctx.service.resolve(named);

  if (ctx.service.isEmpty()) {
    throw new RouterFlipError('NO_ROUTERS', 'No routers are configured yet.', {
      hint: 'Add your first gateway with `routerflip add`.',
    });
  }
  if (!isInteractive()) {
    throw new RouterFlipError('BAD_USAGE', 'Which router? No name was given and there is no terminal to ask on.', {
      hint: `Pass a name, for example: \`routerflip test ${ctx.service.list()[0]?.name ?? '<name>'}\`.`,
      exitCode: 2,
    });
  }

  const views = await ctx.service.views();
  const initial = Math.max(0, views.findIndex((view) => view.isActive));
  const id = await select<string>({
    message,
    options: routerOptions(views),
    initial,
  });
  return ctx.service.resolve(id);
}

/** JSON projection of a router. Contains a mask, never a key. */
export function routerJson(view: RouterView): Record<string, unknown> {
  return {
    id: view.id,
    name: view.name,
    baseUrl: view.baseUrl,
    description: view.description,
    apiKey: view.maskedKey,
    hasKey: view.hasKey,
    authEnvVar: view.authEnvVar,
    provider: view.provider,
    isActive: view.isActive,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}
