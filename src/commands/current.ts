/**
 * `routerflip current` — which gateway is selected, and how.
 *
 * "Current" has two possible meanings, so both are shown: the router RouterFlip
 * has selected, and whether that choice is actually written into Claude Code's
 * configuration right now.
 */
import type { AppContext } from '../context.ts';
import type { Activation, State } from '../core/schema.ts';
import { loadState } from '../core/store.ts';
import { currentActivation } from '../services/activation.ts';
import { blank, json, line, note } from '../ui/output.ts';
import { theme } from '../ui/theme.ts';
import { relativeTime, routerDetailLines } from '../ui/views.ts';
import { routerJson, type CommandResult } from './shared.ts';

/**
 * How the current router is in force: written into Claude Code's own settings, or
 * only ever handed to a launched process.
 *
 * A temporary launch leaves nothing behind for Claude Code to read, so it is
 * reported from RouterFlip's own record of the last one rather than claimed to be
 * still in effect.
 */
function modeOf(routerId: string, activation: Activation | undefined, state: State): 'permanent' | 'temporary' | 'none' {
  if (activation && activation.routerId === routerId) return 'permanent';
  if (state.lastTemporaryRouterId === routerId) return 'temporary';
  return 'none';
}

export async function currentCommand(ctx: AppContext): Promise<CommandResult> {
  const activeId = ctx.service.activeId;
  const router = activeId === undefined ? undefined : ctx.service.find(activeId);
  const activation = currentActivation();
  const state = loadState();
  const mode = router ? modeOf(router.id, activation, state) : 'none';
  const account = router ? ctx.service.activeAccountOf(router) : undefined;

  if (ctx.json) {
    const view = router ? await ctx.service.view(router) : undefined;
    json({
      ok: true,
      router: view ? routerJson(view) : null,
      // A mask, never a key — this is the same projection `list --json` uses.
      account:
        view && account
          ? {
              id: account.id,
              name: account.name,
              apiKey: view.maskedKey,
              ...(account.model ? { model: account.model } : {}),
            }
          : null,
      mode,
      permanent: activation
        ? {
            router: activation.routerName,
            ...(activation.accountName ? { account: activation.accountName } : {}),
            appliedAt: activation.appliedAt,
            targetFile: activation.targetFile,
            managedKeys: activation.managedKeys,
          }
        : null,
    });
    return 0;
  }

  const t = theme();
  if (!router) {
    blank();
    note('  No router is selected yet.');
    note(`  ${t.dim('Choose one with `routerflip use`, or add your first with `routerflip add`.')}`);
    blank();
    return ctx.service.isEmpty() ? 0 : 1;
  }

  const view = await ctx.service.view(router);
  blank();
  for (const row of routerDetailLines(view)) line(row);
  blank();

  line(`  ${t.muted('Account')}`);
  if (account) {
    const total = view.accountCount > 1 ? t.dim(`  (of ${view.accountCount})`) : '';
    line(`  ${t.text(account.name)}${total}`);
  } else {
    line(`  ${t.warning('none — this router has no accounts')}`);
  }
  blank();

  line(`  ${t.muted('Mode')}`);
  if (mode === 'permanent') line(`  ${t.success('permanent')}`);
  else if (mode === 'temporary') {
    const when = state.lastTemporaryAt ? t.dim(` · last launched ${relativeTime(state.lastTemporaryAt)}`) : '';
    line(`  ${t.accent('temporary')}${when}`);
  } else line(`  ${t.dim('none — selected in RouterFlip only')}`);
  blank();

  line(`  ${t.muted('Permanent')}`);
  if (activation && activation.routerId === router.id) {
    const named = activation.accountName ? t.dim(` · ${activation.accountName}`) : '';
    line(`  ${t.success('active')}${named} ${t.dim(`in ${activation.targetFile} · applied ${relativeTime(activation.appliedAt)}`)}`);
  } else if (activation) {
    line(`  ${t.warning(activation.routerName)} ${t.dim(`is the one written into ${activation.targetFile}`)}`);
  } else {
    line(`  ${t.dim('not applied — Claude Code is using its own configuration')}`);
  }
  blank();
  return 0;
}
