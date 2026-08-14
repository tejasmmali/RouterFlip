/**
 * `routerflip claude [args…]` — run Claude Code through a gateway, right now.
 *
 * A convenience wrapper over temporary mode: it defaults to the current router,
 * forwards every remaining argument untouched (`routerflip claude -- --resume`)
 * and exits with the child's own exit code.
 */
import type { AppContext } from '../context.ts';
import type { Router } from '../core/schema.ts';
import { activateTemporary } from './use.ts';
import { pickRouter, routerArg, type CommandResult } from './shared.ts';

/** The router to run: `-r name` first, then the current one, then a prompt. */
async function targetRouter(ctx: AppContext): Promise<Router> {
  const named = routerArg(ctx);
  if (named !== undefined) return ctx.service.resolve(named);
  const active = ctx.service.activeId;
  if (active !== undefined) return ctx.service.resolve(active);
  return pickRouter(ctx, 'Run Claude Code with which router?');
}

export async function runCommand(ctx: AppContext): Promise<CommandResult> {
  const router = await targetRouter(ctx);
  return activateTemporary(ctx, router, ctx.rest);
}
