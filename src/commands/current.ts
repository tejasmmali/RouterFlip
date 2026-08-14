/**
 * `routerflip current` — which gateway is selected, and how.
 *
 * "Current" has two possible meanings, so both are shown: the router RouterFlip
 * has selected, and whether that choice is actually written into Claude Code's
 * configuration right now.
 */
import type { AppContext } from '../context.ts';
import { currentActivation } from '../services/activation.ts';
import { blank, json, line, note } from '../ui/output.ts';
import { theme } from '../ui/theme.ts';
import { relativeTime, routerDetailLines } from '../ui/views.ts';
import { routerJson, type CommandResult } from './shared.ts';

export async function currentCommand(ctx: AppContext): Promise<CommandResult> {
  const activeId = ctx.service.activeId;
  const router = activeId === undefined ? undefined : ctx.service.find(activeId);
  const activation = currentActivation();

  if (ctx.json) {
    const view = router ? await ctx.service.view(router) : undefined;
    json({
      ok: true,
      router: view ? routerJson(view) : null,
      permanent: activation
        ? {
            router: activation.routerName,
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

  line(`  ${t.muted('Permanent')}`);
  if (activation && activation.routerId === router.id) {
    line(`  ${t.success('active')} ${t.dim(`in ${activation.targetFile} · applied ${relativeTime(activation.appliedAt)}`)}`);
  } else if (activation) {
    line(`  ${t.warning(activation.routerName)} ${t.dim(`is the one written into ${activation.targetFile}`)}`);
  } else {
    line(`  ${t.dim('not applied — Claude Code is using its own configuration')}`);
  }
  blank();
  return 0;
}
