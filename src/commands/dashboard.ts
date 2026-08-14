/**
 * The interactive dashboard — bare `routerflip` (spec §1).
 *
 * Everything here is layout and key handling: every action delegates to the exact
 * command function the flag-driven CLI calls, so the two surfaces cannot drift
 * apart. Anything that prints or prompts runs as an inline view *inside* the
 * dashboard's own frame, which is blanked first — so one view is on screen at a
 * time and the dashboard comes back exactly as it was.
 */
import type { AppContext } from '../context.ts';
import type { RouterView } from '../core/routers.ts';
import type { Router } from '../core/schema.ts';
import { isCancelled } from '../errors.ts';
import { openInput, type InputSession } from '../ui/input.ts';
import { isShortcut, type Key } from '../ui/keys.ts';
import { blank, note, printError } from '../ui/output.ts';
import { runScreen, withInlineView, type ScreenOutcome, type Viewport } from '../ui/screen.ts';
import { theme } from '../ui/theme.ts';
import { bannerLines, emptyStateLines, keybar, routerListLines } from '../ui/views.ts';
import { addCommand } from './add.ts';
import { deleteCommand } from './delete.ts';
import { editCommand } from './edit.ts';
import { listCommand } from './list.ts';
import { runTest } from './test.ts';
import { useRouter } from './use.ts';
import type { CommandResult } from './shared.ts';

/** A router occupies two rows in the list: the name, then its URL. */
const ROWS_PER_ROUTER = 2;

interface DashboardResult {
  readonly exitCode: number;
}

/**
 * Waits for one keypress, so output from an action can be read before the
 * full-screen view paints over it.
 *
 * The session opened here sits on top of the dashboard's own, which is what keeps
 * a single reader: only the topmost session is given keys, and this one is closed
 * before the dashboard is handed back.
 */
async function pressAnyKey(): Promise<void> {
  blank();
  note(`  ${theme().dim('Press any key to return to the dashboard.')}`);
  await new Promise<void>((resolve) => {
    let session: InputSession | undefined;
    session = openInput(() => {
      session?.close();
      resolve();
    });
  });
}

export async function dashboardCommand(ctx: AppContext): Promise<CommandResult> {
  // `--json` has no interactive meaning; the machine-readable equivalent of the
  // dashboard is the router list.
  if (ctx.json) return listCommand(ctx);

  let views = await ctx.service.views();
  let cursor = Math.max(0, views.findIndex((view) => view.isActive));
  let status: string | undefined;

  const current = (): RouterView | undefined => views[cursor];
  const routerFor = (view: RouterView): Router => ctx.service.resolve(view.id);

  const refresh = async (): Promise<void> => {
    views = await ctx.service.views();
    cursor = views.length === 0 ? 0 : Math.min(cursor, views.length - 1);
  };

  /** The line above the keybar: the last action's result, or a standing summary. */
  const footer = (): string => {
    const t = theme();
    if (status) return t.text(status);
    if (views.length === 0) return t.muted('No routers yet — press A to add your first gateway.');
    const active = views.find((view) => view.isActive);
    const count = `${views.length} router${views.length === 1 ? '' : 's'}`;
    const selected = active ? `${t.muted('current')} ${t.text(active.name)}` : t.muted('none selected');
    return `${t.muted(count)}  ${t.dim('·')}  ${selected}`;
  };

  /**
   * The slice of the list that fits, centred on the cursor. Derived from the
   * cursor rather than kept as scroll state, so the frame is a pure function of
   * the selection and a resize can never desynchronise it.
   */
  const listWindow = (room: number): string[] => {
    const capacity = Math.max(1, Math.floor(room / ROWS_PER_ROUTER));
    if (views.length <= capacity) return routerListLines(views, cursor);

    const t = theme();
    const start = Math.max(0, Math.min(cursor - Math.floor((capacity - 1) / 2), views.length - capacity));
    const out = routerListLines(views.slice(start, start + capacity), cursor - start);
    if (start > 0) out.unshift(`  ${t.dim(`${start} more above`)}`);
    const below = views.length - start - capacity;
    if (below > 0) out.push(`  ${t.dim(`${below} more below`)}`);
    return out;
  };

  const render = (view: Viewport): string[] => {
    const head = [...bannerLines(view.width), ''];
    const foot = ['', `  ${footer()}`, '', `  ${keybar()}`];
    const room = Math.max(ROWS_PER_ROUTER, view.height - 1 - head.length - foot.length);
    const body = views.length === 0 ? emptyStateLines(view.width) : listWindow(room);
    // Pad so the keybar sits on the bottom row however short the list is.
    while (body.length < room) body.push('');
    return [...head, ...body, ...foot];
  };

  /**
   * Runs a command as a view on top of the dashboard: the frame is blanked, the
   * command draws into it, and the dashboard paints again once it returns. A
   * cancelled prompt is an ordinary outcome here — the dashboard stays open — and
   * an error is shown in place rather than taking the whole process down.
   */
  const inline = async (body: () => Promise<string | undefined>): Promise<undefined> => {
    await withInlineView(async () => {
      try {
        status = await body();
        await pressAnyKey();
      } catch (error) {
        if (isCancelled(error)) {
          status = 'Cancelled. Nothing was changed.';
          return;
        }
        status = undefined;
        printError(error);
        await pressAnyKey();
      }
    });
    await refresh();
    return undefined;
  };

  const onAdd = (): Promise<undefined> =>
    inline(async () => {
      const before = ctx.service.list().length;
      await addCommand(ctx, { quiet: true });
      return ctx.service.list().length > before ? 'Router added.' : undefined;
    });

  const onEdit = (view: RouterView): Promise<undefined> =>
    inline(async () => {
      await editCommand(ctx, routerFor(view));
      return undefined;
    });

  const onDelete = (view: RouterView): Promise<undefined> =>
    inline(async () => {
      await deleteCommand(ctx, routerFor(view));
      return undefined;
    });

  const onTest = (view: RouterView): Promise<undefined> =>
    inline(async () => {
      const report = await runTest(ctx, routerFor(view));
      return report.ok ? `${report.routerName} is ready to use.` : `${report.routerName} needs attention.`;
    });

  /**
   * `C` marks RouterFlip's own selection. Claude Code is deliberately untouched:
   * that only happens when the user asks for permanent mode.
   */
  const onCurrent = (view: RouterView): undefined => {
    ctx.service.setActive(view.id);
    views = views.map((row) => ({ ...row, isActive: row.id === view.id }));
    status = `${view.name} is now the selected router.`;
    return undefined;
  };

  /**
   * `Enter` runs the full `use` flow. Temporary mode hands the terminal to Claude
   * Code for good, so once the child exits there is nothing sensible to return to —
   * the dashboard finishes with the child's exit code.
   */
  const onSelect = async (view: RouterView): Promise<ScreenOutcome<DashboardResult> | undefined> => {
    let launched: DashboardResult | undefined;
    await withInlineView(async () => {
      try {
        const outcome = await useRouter(ctx, routerFor(view));
        if (outcome.launched) {
          launched = { exitCode: outcome.exitCode };
          return;
        }
        await pressAnyKey();
      } catch (error) {
        if (isCancelled(error)) {
          status = 'Cancelled. Nothing was changed.';
          return;
        }
        status = undefined;
        printError(error);
        await pressAnyKey();
      }
    });
    if (launched) return { done: true, value: launched };
    await refresh();
    return undefined;
  };

  const move = (delta: number): undefined => {
    if (views.length === 0) return undefined;
    cursor = (cursor + delta + views.length) % views.length;
    status = undefined;
    return undefined;
  };

  type Outcome = ScreenOutcome<DashboardResult> | undefined | Promise<ScreenOutcome<DashboardResult> | undefined>;

  const onKey = (key: Key): Outcome => {
    if (key.name === 'up' || isShortcut(key, 'k')) return move(-1);
    if (key.name === 'down' || isShortcut(key, 'j')) return move(1);
    if (key.name === 'home') return move(-cursor);
    if (key.name === 'end') return move(views.length - 1 - cursor);
    if (key.name === 'escape' || isShortcut(key, 'q')) return { done: true, value: { exitCode: 0 } };
    if (isShortcut(key, 'a')) return onAdd();
    if (isShortcut(key, 'r')) return refresh().then(() => undefined);

    const view = current();
    // With no routers there is nothing to act on, so Enter means "add one".
    if (view === undefined) return key.name === 'enter' ? onAdd() : undefined;

    if (key.name === 'enter') return onSelect(view);
    if (isShortcut(key, 'e')) return onEdit(view);
    if (isShortcut(key, 'd')) return onDelete(view);
    if (isShortcut(key, 't')) return onTest(view);
    if (isShortcut(key, 'c')) return onCurrent(view);
    return undefined;
  };

  const result = await runScreen<DashboardResult>({ render, onKey });
  return result?.exitCode ?? 0;
}
