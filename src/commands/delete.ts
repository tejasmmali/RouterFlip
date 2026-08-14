/**
 * `routerflip delete [name]` — remove a profile and its stored key.
 *
 * Confirmation is mandatory (spec §10): interactively it is a danger-styled
 * prompt, non-interactively it requires `--yes`, and there is no code path that
 * infers consent from a pipe.
 */
import type { AppContext } from '../context.ts';
import type { Router } from '../core/schema.ts';
import { clearPermanent, currentActivation } from '../services/activation.ts';
import { blank, json, note, success } from '../ui/output.ts';
import { theme } from '../ui/theme.ts';
import { confirmAction, pickRouter, type CommandResult } from './shared.ts';

export async function deleteCommand(ctx: AppContext, target?: Router): Promise<CommandResult> {
  const router = target ?? (await pickRouter(ctx, 'Delete which router?'));
  const view = await ctx.service.view(router);
  const activation = currentActivation();
  const isPermanent = activation?.routerId === router.id;

  const details = [
    `Base URL: ${view.baseUrl}`,
    view.hasKey ? 'Its API key will be removed from your credential store.' : 'No stored key to remove.',
    ...(isPermanent ? ['It is currently applied to Claude Code — that will be reverted too.'] : []),
  ];

  const approved = await confirmAction(ctx, {
    message: `Delete router "${router.name}"?`,
    details,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!approved) {
    if (!ctx.json) note('  Nothing was deleted.');
    return 0;
  }

  // Revert Claude Code first: a settings file pointing at a profile that no
  // longer exists is worse than either state on its own.
  let reverted: string | undefined;
  if (isPermanent) {
    const outcome = clearPermanent(ctx.provider);
    reverted = outcome?.result.targetFile;
  }

  await ctx.service.remove(router.id);

  if (ctx.json) {
    json({ ok: true, deleted: router.name, ...(reverted ? { revertedIn: reverted } : {}) });
    return 0;
  }

  blank();
  success(`Router "${router.name}" deleted.`);
  if (reverted) note(`  ${theme().dim(`Claude Code settings reverted in ${reverted}.`)}`);
  const remaining = ctx.service.list().length;
  note(`  ${theme().muted(`${remaining} router${remaining === 1 ? '' : 's'} left.`)}`);
  return 0;
}
