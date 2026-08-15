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
import type { AccountView, RouterView } from '../core/routers.ts';
import type { Account, Router } from '../core/schema.ts';
import { isCancelled } from '../errors.ts';
import { openInput, type InputSession } from '../ui/input.ts';
import { isShortcut, type Key } from '../ui/keys.ts';
import { blank, note, printError } from '../ui/output.ts';
import { runScreen, withInlineView, type ScreenOutcome, type Viewport } from '../ui/screen.ts';
import { theme } from '../ui/theme.ts';
import {
  accountBannerLines,
  accountKeybar,
  accountListLines,
  bannerLines,
  emptyAccountsLines,
  emptyStateLines,
  keybar,
  routerListLines,
} from '../ui/views.ts';
import { addAccount, deleteAccount, editAccount } from './accounts.ts';
import { addCommand } from './add.ts';
import { deleteCommand } from './delete.ts';
import { editCommand } from './edit.ts';
import { listCommand } from './list.ts';
import { chooseModel } from './models.ts';
import { runTest } from './test.ts';
import { useRouter } from './use.ts';
import type { CommandResult } from './shared.ts';

/** A router occupies two rows in the list: the name, then its URL. */
const ROWS_PER_ROUTER = 2;
/** An account is the same two rows: the name, then its mask. */
const ROWS_PER_ACCOUNT = 2;

/**
 * Which list is on screen.
 *
 * The account screen is a *mode* of the same screen rather than a second one:
 * `runScreen` owns the alternate buffer, and entering it twice would leave the
 * terminal to be restored twice as well.
 */
type Mode = { readonly kind: 'routers' } | { readonly kind: 'accounts'; readonly routerId: string };

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

  // The account screen's own state. `owner` is the router whose accounts are
  // listed, kept as a view so the banner can be drawn without an await.
  let mode: Mode = { kind: 'routers' };
  let owner: RouterView | undefined;
  let accounts: AccountView[] = [];
  let accountCursor = 0;

  const current = (): RouterView | undefined => views[cursor];
  const routerFor = (view: RouterView): Router => ctx.service.resolve(view.id);
  const currentAccount = (): AccountView | undefined => accounts[accountCursor];

  const refresh = async (): Promise<void> => {
    views = await ctx.service.views();
    cursor = views.length === 0 ? 0 : Math.min(cursor, views.length - 1);
  };

  /**
   * Reloads the account screen after an action.
   *
   * A router that disappeared underneath us (deleted from the account screen is
   * not possible today, but a stale id must never render) sends the dashboard back
   * to the router list rather than drawing an empty frame.
   */
  const refreshAccounts = async (): Promise<void> => {
    if (mode.kind !== 'accounts') return;
    const router = ctx.service.find(mode.routerId);
    if (!router) {
      mode = { kind: 'routers' };
      owner = undefined;
      accounts = [];
      await refresh();
      return;
    }
    owner = await ctx.service.view(router);
    accounts = await ctx.service.accountViews(router);
    accountCursor = accounts.length === 0 ? 0 : Math.min(accountCursor, accounts.length - 1);
  };

  /** Enter on a router opens its accounts: the router owns the URL, an account the key. */
  const openAccounts = async (view: RouterView): Promise<undefined> => {
    mode = { kind: 'accounts', routerId: view.id };
    accountCursor = 0;
    status = undefined;
    await refreshAccounts();
    // Start on the account a launch would use, so Enter twice repeats last time.
    const active = accounts.findIndex((account) => account.isActive);
    if (active >= 0) accountCursor = active;
    return undefined;
  };

  const backToRouters = async (): Promise<undefined> => {
    mode = { kind: 'routers' };
    owner = undefined;
    accounts = [];
    status = undefined;
    await refresh();
    return undefined;
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

  /** The account screen's footer: how many, and which one is active. */
  const accountFooter = (routerName: string): string => {
    const t = theme();
    if (status) return t.text(status);
    if (accounts.length === 0) return t.muted(`${routerName} has no accounts — press A to add one.`);
    const active = accounts.find((account) => account.isActive);
    const count = `${accounts.length} account${accounts.length === 1 ? '' : 's'}`;
    const selected = active ? `${t.muted('active')} ${t.text(active.name)}` : t.muted('none active');
    return `${t.muted(count)}  ${t.dim('·')}  ${selected}`;
  };

  /** The same windowing as the router list, so long account lists scroll alike. */
  const accountWindow = (room: number): string[] => {
    const capacity = Math.max(1, Math.floor(room / ROWS_PER_ACCOUNT));
    if (accounts.length <= capacity) return accountListLines(accounts, accountCursor);

    const t = theme();
    const start = Math.max(0, Math.min(accountCursor - Math.floor((capacity - 1) / 2), accounts.length - capacity));
    const out = accountListLines(accounts.slice(start, start + capacity), accountCursor - start);
    if (start > 0) out.unshift(`  ${t.dim(`${start} more above`)}`);
    const below = accounts.length - start - capacity;
    if (below > 0) out.push(`  ${t.dim(`${below} more below`)}`);
    return out;
  };

  const renderAccounts = (view: Viewport, router: RouterView): string[] => {
    const head = [...accountBannerLines(router, view.width), '', `  ${theme().muted('Accounts')}`, ''];
    const foot = ['', `  ${accountFooter(router.name)}`, '', `  ${accountKeybar()}`];
    const room = Math.max(ROWS_PER_ACCOUNT, view.height - 1 - head.length - foot.length);
    const body = accounts.length === 0 ? emptyAccountsLines(router.name, view.width) : accountWindow(room);
    while (body.length < room) body.push('');
    return [...head, ...body, ...foot];
  };

  const render = (view: Viewport): string[] => {
    // A missing owner can only mean the router went away between frames; the
    // router list is always safe to draw.
    if (mode.kind === 'accounts' && owner) return renderAccounts(view, owner);
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
   *
   * `pause: false` skips the "press any key" step for an action whose whole result
   * fits in the footer line, so a quick change costs one keypress rather than two.
   * A *failure* always pauses regardless: an error nobody read is an error lost.
   */
  const inline = async (
    body: () => Promise<string | undefined>,
    options: { readonly pause?: boolean } = {},
  ): Promise<undefined> => {
    await withInlineView(async () => {
      try {
        status = await body();
        if (options.pause !== false) await pressAnyKey();
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
    await refreshAccounts();
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
   *
   * `account` is passed from the account screen, so the launch uses the router's
   * base URL together with *that* account's credential.
   */
  const onSelect = async (view: RouterView, account?: Account): Promise<ScreenOutcome<DashboardResult> | undefined> => {
    let launched: DashboardResult | undefined;
    await withInlineView(async () => {
      try {
        const outcome = await useRouter(ctx, routerFor(view), account);
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

  // ── Account screen actions ────────────────────────────────────────────────
  //
  // Each one delegates to the same function `routerflip accounts …` calls, so the
  // two surfaces cannot drift apart, and each runs as an inline view so only one
  // thing is ever on screen.

  /** The router whose accounts are listed, resolved fresh from config. */
  const ownerRouter = (): Router | undefined => {
    const active = mode;
    return active.kind === 'accounts' ? ctx.service.find(active.routerId) : undefined;
  };

  const onAddAccount = (): Promise<undefined> =>
    inline(async () => {
      const router = ownerRouter();
      if (!router) return undefined;
      const before = router.accounts.length;
      await addAccount(ctx, router);
      return ctx.service.resolve(router.id).accounts.length > before ? 'Account added.' : undefined;
    });

  const onEditAccount = (view: AccountView): Promise<undefined> =>
    inline(async () => {
      const router = ownerRouter();
      if (router) await editAccount(ctx, router, view.id);
      return undefined;
    });

  const onDeleteAccount = (view: AccountView): Promise<undefined> =>
    inline(async () => {
      const router = ownerRouter();
      if (router) await deleteAccount(ctx, router, view.id);
      return undefined;
    });

  /**
   * `M` opens the model picker for the account under the cursor — the same picker
   * the `use` action screen opens, so a model can be changed without launching
   * anything.
   *
   * Bound on this screen only. The router list has no account to remember a choice
   * on, and every text prompt (a name, a key) routes printable keys to its own
   * editor, so `M` cannot mean "change model" anywhere a character is being typed.
   */
  const onModelAccount = (view: AccountView): Promise<undefined> =>
    inline(
      async () => {
        const router = ownerRouter();
        if (!router) return undefined;
        const account = ctx.service.findAccount(router, view.id);
        if (!account) return undefined;
        // `status` carries the outcome, which is why nothing pauses here: the
        // dashboard's own footer is the confirmation.
        return (await chooseModel(ctx, router, account)).status;
      },
      { pause: false },
    );

  /**
   * Enter on an account selects *both* halves — router and credential — and then
   * runs the ordinary `use` flow with them, which is where Temporary/Permanent is
   * chosen.
   */
  const onSelectAccount = async (view: AccountView): Promise<ScreenOutcome<DashboardResult> | undefined> => {
    const router = ownerRouter();
    if (!router || !owner) return undefined;
    const { account } = ctx.service.setActiveAccount(router.id, view.id);
    const outcome = await onSelect(owner, account);
    if (outcome) return outcome;
    await refreshAccounts();
    return undefined;
  };

  const move = (delta: number): undefined => {
    if (views.length === 0) return undefined;
    cursor = (cursor + delta + views.length) % views.length;
    status = undefined;
    return undefined;
  };

  const moveAccount = (delta: number): undefined => {
    if (accounts.length === 0) return undefined;
    accountCursor = (accountCursor + delta + accounts.length) % accounts.length;
    status = undefined;
    return undefined;
  };

  type Outcome = ScreenOutcome<DashboardResult> | undefined | Promise<ScreenOutcome<DashboardResult> | undefined>;

  const onAccountKey = (key: Key): Outcome => {
    if (key.name === 'up' || isShortcut(key, 'k')) return moveAccount(-1);
    if (key.name === 'down' || isShortcut(key, 'j')) return moveAccount(1);
    if (key.name === 'home') return moveAccount(-accountCursor);
    if (key.name === 'end') return moveAccount(accounts.length - 1 - accountCursor);
    // `B` and Esc go back rather than quitting: this screen was opened from the
    // router list, and leaving RouterFlip from here would lose the user's place.
    if (key.name === 'escape' || isShortcut(key, 'b') || key.name === 'left') return backToRouters();
    if (isShortcut(key, 'q')) return { done: true, value: { exitCode: 0 } };
    if (isShortcut(key, 'a')) return onAddAccount();
    if (isShortcut(key, 'r')) return refreshAccounts().then(() => undefined);

    const view = currentAccount();
    // No accounts left: Enter is the way to create the one this router needs.
    if (view === undefined) return key.name === 'enter' ? onAddAccount() : undefined;

    if (key.name === 'enter') return onSelectAccount(view);
    if (isShortcut(key, 'e')) return onEditAccount(view);
    if (isShortcut(key, 'd')) return onDeleteAccount(view);
    if (isShortcut(key, 'm')) return onModelAccount(view);
    return undefined;
  };

  const onRouterKey = (key: Key): Outcome => {
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

    // Enter opens the account screen: the router owns the base URL, but an account
    // owns the key, so which one to launch with is asked before anything happens.
    if (key.name === 'enter' || key.name === 'right') return openAccounts(view);
    if (isShortcut(key, 'e')) return onEdit(view);
    if (isShortcut(key, 'd')) return onDelete(view);
    if (isShortcut(key, 't')) return onTest(view);
    if (isShortcut(key, 'c')) return onCurrent(view);
    return undefined;
  };

  const onKey = (key: Key): Outcome => (mode.kind === 'accounts' ? onAccountKey(key) : onRouterKey(key));

  const result = await runScreen<DashboardResult>({ render, onKey });
  return result?.exitCode ?? 0;
}
