/**
 * `routerflip list` — every configured gateway, with the active one marked.
 *
 * Renders through the shared views so this is the same table the dashboard shows,
 * and through `routerJson` for `--json`, which carries a mask instead of a key.
 */
import type { AppContext } from '../context.ts';
import { blank, json, line, note } from '../ui/output.ts';
import { theme } from '../ui/theme.ts';
import { terminalWidth } from '../ui/width.ts';
import { emptyStateLines, routerTableLines } from '../ui/views.ts';
import { routerJson, type CommandResult } from './shared.ts';

export async function listCommand(ctx: AppContext): Promise<CommandResult> {
  const views = await ctx.service.views();

  if (ctx.json) {
    json({
      ok: true,
      count: views.length,
      activeRouter: ctx.service.activeId ?? null,
      routers: views.map(routerJson),
    });
    return 0;
  }

  if (views.length === 0) {
    blank();
    for (const row of emptyStateLines(terminalWidth())) line(row);
    blank();
    return 0;
  }

  const t = theme();
  blank();
  for (const row of routerTableLines(views)) line(row);
  blank();

  const active = views.find((view) => view.isActive);
  const count = `${views.length} router${views.length === 1 ? '' : 's'}`;
  // The account is named only when the current router has more than one, so the
  // summary line stays a single short sentence for everyone else.
  const account = active && active.accountCount > 1 && active.activeAccountName ? t.dim(` (${active.activeAccountName})`) : '';
  note(
    `  ${t.muted(count)}${active ? `${t.muted(' · current: ')}${t.text(active.name)}${account}` : t.muted(' · none selected')}`,
  );
  return 0;
}
