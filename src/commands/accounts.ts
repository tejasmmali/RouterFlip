/**
 * `routerflip accounts <router> [add|edit|delete|use] [account]`
 *
 * A router owns the base URL; each of its accounts owns one credential. This is
 * the shell-side counterpart of the dashboard's account screen, and it is
 * deliberately positional-only: the interactive UI is where account management is
 * meant to happen, so the parser gains one flag (`--account`) rather than a
 * subcommand tree.
 *
 * Every path here obeys the same rule as the rest of RouterFlip: keys are read
 * from and written to the OS credential store, and only ever *masked* on screen.
 */
import type { AppContext } from '../context.ts';
import type { Account, Router } from '../core/schema.ts';
import type { AccountPatch } from '../core/routers.ts';
import { RouterFlipError } from '../errors.ts';
import { currentActivation } from '../services/activation.ts';
import { isInteractive } from '../ui/input.ts';
import { blank, heading, json, line, note, success } from '../ui/output.ts';
import { password, promptIntro, text, KEEP_EXISTING } from '../ui/prompts.ts';
import { theme } from '../ui/theme.ts';
import { terminalWidth } from '../ui/width.ts';
import { accountDetailLines, accountListLines, emptyAccountsLines } from '../ui/views.ts';
import { accountJson, confirmAction, keyFromFlags, pickRouter, selectAccount, type CommandResult } from './shared.ts';

const VERBS = ['add', 'edit', 'delete', 'remove', 'rm', 'use', 'select'] as const;
type Verb = (typeof VERBS)[number];

function isVerb(token: string | undefined): token is Verb {
  return token !== undefined && (VERBS as readonly string[]).includes(token);
}

/**
 * The router whose accounts are being managed.
 *
 * `--name` is *not* accepted as a selector here, unlike elsewhere: for these
 * subcommands it means the account's name.
 */
async function targetRouter(ctx: AppContext, token: string | undefined): Promise<Router> {
  if (token !== undefined) return ctx.service.resolve(token);
  if (!isInteractive()) {
    throw new RouterFlipError('BAD_USAGE', 'Which router? `accounts` needs a router name or id.', {
      hint: 'Example: routerflip accounts GoRouter',
      exitCode: 2,
    });
  }
  return pickRouter(ctx, 'Accounts of which router?');
}

async function resolveTarget(
  ctx: AppContext,
  router: Router,
  selector: string | undefined,
  verb: string,
  what: string,
): Promise<Account> {
  if (selector !== undefined) return ctx.service.resolveAccount(router, selector);
  if (router.accounts.length === 0) {
    throw new RouterFlipError('ROUTER_NOT_FOUND', `"${router.name}" has no accounts yet.`, {
      hint: `Add one with \`routerflip accounts ${router.name} add\`.`,
    });
  }
  if (!isInteractive()) {
    throw new RouterFlipError('BAD_USAGE', `Which account should be ${what}?`, {
      hint: `Name it, for example: routerflip accounts ${router.name} ${verb} "Account 2"`,
      exitCode: 2,
    });
  }
  return selectAccount(ctx, router, `Which account should be ${what}?`);
}

/** `routerflip accounts <router>` — the table of accounts, as the screen shows it. */
async function listAccounts(ctx: AppContext, router: Router): Promise<CommandResult> {
  const views = await ctx.service.accountViews(router);

  if (ctx.json) {
    json({
      ok: true,
      router: router.name,
      baseUrl: router.baseUrl,
      count: views.length,
      activeAccount: ctx.service.activeAccountOf(router)?.id ?? null,
      accounts: views.map(accountJson),
    });
    return 0;
  }

  const t = theme();
  blank();
  if (views.length === 0) {
    for (const row of emptyAccountsLines(router.name, terminalWidth())) line(row);
    blank();
    return 0;
  }
  heading(`  ${router.name}`);
  line(`  ${t.dim(router.baseUrl)}`);
  blank();
  for (const row of accountListLines(views)) line(row);
  blank();
  const count = `${views.length} account${views.length === 1 ? '' : 's'}`;
  const active = ctx.service.activeAccountOf(router);
  note(`  ${t.muted(count)}${active ? `${t.muted(' · active: ')}${t.text(active.name)}` : ''}`);
  return 0;
}

/** A default name that does not collide: "Account 2" for the second, and so on. */
function suggestedName(router: Router): string {
  const taken = new Set(router.accounts.map((account) => account.name.toLowerCase()));
  for (let index = router.accounts.length + 1; ; index += 1) {
    const candidate = `Account ${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * `accounts <router> add` — the form, or `--name`/`--key` for scripts.
 *
 * Exported because the dashboard's `A` key runs this very function inside its own
 * frame: one form, one set of rules, whichever surface the user came from.
 */
export async function addAccount(ctx: AppContext, router: Router): Promise<CommandResult> {
  const flagName = ctx.flags.str('name');
  const flagKey = await keyFromFlags(ctx);

  let name: string;
  let apiKey: string;
  let description: string;

  if (flagName !== undefined && flagKey !== undefined) {
    name = flagName;
    apiKey = flagKey;
    description = ctx.flags.str('description') ?? '';
  } else if (!isInteractive()) {
    throw new RouterFlipError('BAD_USAGE', 'Adding an account needs a name and a key.', {
      hint: `Example: routerflip accounts ${router.name} add --name "Account 2" --key-stdin`,
      exitCode: 2,
    });
  } else {
    const t = theme();
    blank();
    heading('  Add an account');
    blank();
    line(`  ${t.muted('Router')}   ${t.text(router.name)}`);
    line(`  ${t.muted('Base URL')} ${t.dim(router.baseUrl)}`);
    blank();
    promptIntro('  The API key is stored in your operating system credential store, never in config.json.');
    blank();

    name = await text({
      message: 'Account name',
      initial: flagName ?? suggestedName(router),
      validate: (value) => {
        try {
          ctx.service.assertAccountNameAvailable(router, value);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : 'Invalid name.';
        }
      },
      help: 'A label for this credential — the base URL belongs to the router.',
    });
    const key = flagKey ?? (await password({ message: 'API Key' }));
    apiKey = key === KEEP_EXISTING ? '' : key;
    description = await text({ message: 'Description', placeholder: 'optional', allowEmpty: true });
  }

  const account = await ctx.service.addAccount(router.id, { name, apiKey, description });
  const updated = ctx.service.resolve(router.id);
  const view = await ctx.service.accountView(updated, account);

  if (ctx.json) {
    json({ ok: true, router: updated.name, account: accountJson(view) });
    return 0;
  }
  blank();
  success(`Account "${account.name}" added to "${updated.name}".`);
  blank();
  for (const row of accountDetailLines(view)) line(row);
  blank();
  note(`  ${theme().dim(`Use it with \`routerflip use ${updated.name} --account "${account.name}"\`.`)}`);
  return 0;
}

/** A patch built purely from flags, for scripted edits. */
async function patchFromFlags(ctx: AppContext): Promise<AccountPatch> {
  const patch: { name?: string; apiKey?: string; description?: string } = {};
  const name = ctx.flags.str('name');
  if (name !== undefined) patch.name = name;
  const key = await keyFromFlags(ctx);
  if (key !== undefined) patch.apiKey = key;
  const description = ctx.flags.str('description');
  if (description !== undefined) patch.description = description;
  return patch;
}

/**
 * The edit form. The key field is seeded with the *mask*: submitting it unchanged
 * keeps the stored secret, and the real key never reaches the screen.
 */
async function patchFromForm(ctx: AppContext, router: Router, account: Account): Promise<AccountPatch> {
  const view = await ctx.service.accountView(router, account);
  const t = theme();

  blank();
  heading(`  Edit ${account.name}`);
  blank();
  line(`  ${t.muted('Router')}   ${t.text(router.name)}`);
  blank();
  note(`  ${t.dim('Leave a field as it is to keep the current value.')}`);
  blank();

  const name = await text({
    message: 'Account name',
    initial: account.name,
    validate: (value) => {
      try {
        ctx.service.assertAccountNameAvailable(router, value, account.id);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : 'Invalid name.';
      }
    },
  });
  const key = await password({
    message: 'API Key',
    ...(view.hasKey ? { existingMask: view.maskedKey } : {}),
    help: view.hasKey ? 'Press Enter to keep the stored key.' : 'No key is stored for this account yet.',
  });
  const description = await text({
    message: 'Description',
    initial: account.description,
    placeholder: 'optional',
    allowEmpty: true,
  });

  return { name, description, ...(key === KEEP_EXISTING ? {} : { apiKey: key }) };
}

/** `accounts <router> edit [account]` — name, key and description. */
export async function editAccount(ctx: AppContext, router: Router, selector: string | undefined): Promise<CommandResult> {
  const account = await resolveTarget(ctx, router, selector, 'edit', 'edited');

  let patch = await patchFromFlags(ctx);
  if (Object.keys(patch).length === 0) {
    if (!isInteractive()) {
      throw new RouterFlipError('BAD_USAGE', 'Nothing to change.', {
        hint: `Pass what to change, for example: routerflip accounts ${router.name} edit "${account.name}" --key-stdin`,
        exitCode: 2,
      });
    }
    patch = await patchFromForm(ctx, router, account);
  }

  const updated = await ctx.service.updateAccount(router.id, account.id, patch);
  const after = ctx.service.resolve(router.id);
  const view = await ctx.service.accountView(after, updated);

  if (ctx.json) {
    json({ ok: true, router: after.name, account: accountJson(view) });
    return 0;
  }
  blank();
  success(`Account "${updated.name}" updated.`);
  blank();
  for (const row of accountDetailLines(view)) line(row);
  blank();

  // A key change leaves an applied settings file serving the previous secret —
  // unless the helper strategy is in use, in which case the key is fetched fresh
  // on every launch and there is nothing to re-apply.
  const activation = currentActivation();
  const embedded = activation !== undefined && !activation.managedKeys.includes('apiKeyHelper');
  if (patch.apiKey !== undefined && embedded && activation.routerId === after.id && activation.accountId === updated.id) {
    note(
      `  ${theme().dim(`Claude Code still has the previous key. Re-apply with \`routerflip use ${after.name} --account "${updated.name}" --permanent\`.`)}`,
    );
  }
  return 0;
}

/**
 * `accounts <router> delete [account]` — remove the account and its credential.
 *
 * Confirmation is mandatory, like `delete`: interactively a danger prompt,
 * non-interactively `--yes`, and never an inferred consent.
 */
export async function deleteAccount(
  ctx: AppContext,
  router: Router,
  selector: string | undefined,
): Promise<CommandResult> {
  const account = await resolveTarget(ctx, router, selector, 'delete', 'deleted');
  const view = await ctx.service.accountView(router, account);
  const successor = router.accounts.find((other) => other.id !== account.id);

  const details = [
    view.hasKey ? 'Its API key will be removed from your credential store.' : 'No stored key to remove.',
    ...(view.isActive
      ? [
          successor
            ? `"${successor.name}" becomes the active account of "${router.name}".`
            : `"${router.name}" will have no accounts left, so there is no key to launch with.`,
        ]
      : []),
  ];

  const approved = await confirmAction(ctx, {
    message: `Delete account "${account.name}" of "${router.name}"?`,
    details,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!approved) {
    if (!ctx.json) note('  Nothing was deleted.');
    return 0;
  }
  await ctx.service.removeAccount(router.id, account.id);
  const after = ctx.service.resolve(router.id);
  const active = ctx.service.activeAccountOf(after);

  if (ctx.json) {
    json({
      ok: true,
      router: after.name,
      deleted: account.name,
      remaining: after.accounts.length,
      activeAccount: active?.id ?? null,
    });
    return 0;
  }

  const t = theme();
  blank();
  success(`Account "${account.name}" deleted from "${after.name}".`);
  if (active) note(`  ${t.muted('Active account: ')}${t.text(active.name)}`);
  else
    note(
      `  ${t.warning(`"${after.name}" has no accounts left.`)} ${t.dim(`Add one with \`routerflip accounts ${after.name} add\`.`)}`,
    );

  // The applied settings file may still name the account that just went away.
  const activation = currentActivation();
  if (activation?.routerId === after.id && activation.accountId === account.id) {
    note(
      `  ${t.dim(
        active
          ? `Claude Code still points at the deleted account. Re-apply with \`routerflip use ${after.name} --permanent\`.`
          : 'Claude Code still points at the deleted account. Revert with `routerflip deactivate`.',
      )}`,
    );
  }
  return 0;
}

/** `accounts <router> use [account]` — select the pair a launch will use. */
async function useAccount(ctx: AppContext, router: Router, selector: string | undefined): Promise<CommandResult> {
  const account = await resolveTarget(ctx, router, selector, 'use', 'selected');
  const { router: updated, account: selected } = ctx.service.setActiveAccount(router.id, account.id);
  const view = await ctx.service.accountView(updated, selected);

  if (ctx.json) {
    json({ ok: true, router: updated.name, baseUrl: updated.baseUrl, account: accountJson(view) });
    return 0;
  }

  const t = theme();
  blank();
  success(`"${selected.name}" is now the active account of "${updated.name}".`);
  blank();
  line(`  ${t.muted('Base URL')} ${t.dim(updated.baseUrl)}`);
  line(`  ${t.muted('API Key')}  ${view.hasKey ? t.dim(view.maskedKey) : t.warning('not stored')}`);
  blank();
  note(`  ${t.dim(`Launch it with \`routerflip use ${updated.name}\`.`)}`);
  return 0;
}

/**
 * The grammar: `accounts [router] [verb] [account]`.
 *
 * `--router` takes the name out of the positionals, and a leading verb means the
 * router was not named at all — so `routerflip accounts add` still works and asks
 * which router. Anything else in the verb slot is a usage error rather than a
 * silently ignored argument.
 */
function parse(ctx: AppContext): { router?: string; verb?: Verb; account?: string } {
  const tokens = [...ctx.positionals];
  const flagRouter = ctx.flags.str('router');
  const router = flagRouter ?? (isVerb(tokens[0]) ? undefined : tokens.shift());

  let verb: Verb | undefined;
  if (isVerb(tokens[0])) {
    verb = tokens[0];
    tokens.shift();
  } else if (tokens[0] !== undefined) {
    throw new RouterFlipError('BAD_USAGE', `Unknown account action "${tokens[0]}".`, {
      hint: 'Try one of: add, edit, delete, use.',
      exitCode: 2,
    });
  }

  const account = tokens[0] ?? ctx.flags.str('account');
  return { ...(router === undefined ? {} : { router }), ...(verb ? { verb } : {}), ...(account === undefined ? {} : { account }) };
}

export async function accountsCommand(ctx: AppContext): Promise<CommandResult> {
  const { router: token, verb, account } = parse(ctx);
  const router = await targetRouter(ctx, token);

  switch (verb) {
    case 'add':
      return addAccount(ctx, router);
    case 'edit':
      return editAccount(ctx, router, account);
    case 'delete':
    case 'remove':
    case 'rm':
      return deleteAccount(ctx, router, account);
    case 'use':
    case 'select':
      return useAccount(ctx, router, account);
    default:
      return listAccounts(ctx, router);
  }
}
