/**
 * `routerflip models <router> [list|add|remove|use] [model]`, and the interactive
 * picker the `M` key opens.
 *
 * The split this file exists to keep (and the reason it is one file rather than
 * two) is that **the list belongs to the router and the selection belongs to the
 * account**: a router describes what its endpoint serves, so every account of it
 * offers the same choices, while "which one did I use last" is a property of the
 * credential. Both halves are non-secret, so both live in config.json — nothing
 * here reads, writes or prints a key.
 *
 * Model selection is optional everywhere. No screen forces a choice, and "no
 * model" is a first-class answer meaning "whatever the provider already defaults
 * to", not a gap to be filled.
 */
import type { AppContext } from '../context.ts';
import type { Account, Router } from '../core/schema.ts';
import { RouterFlipError } from '../errors.ts';
import { isInteractive } from '../ui/input.ts';
import { blank, heading, json, line, note, success } from '../ui/output.ts';
import { box } from '../ui/box.ts';
import { select, text, type SelectOption } from '../ui/prompts.ts';
import { theme } from '../ui/theme.ts';
import { terminalWidth } from '../ui/width.ts';
import { confirmAction, pickRouter, selectAccount, type CommandResult } from './shared.ts';

const VERBS = ['list', 'add', 'remove', 'delete', 'rm', 'use', 'select', 'clear', 'none'] as const;
type Verb = (typeof VERBS)[number];

function isVerb(token: string | undefined): token is Verb {
  return token !== undefined && (VERBS as readonly string[]).includes(token);
}

/**
 * The router whose models are being managed.
 *
 * `--name` is not accepted as a selector, exactly as in `accounts`: in this
 * grammar a bare name means the *model*.
 */
async function targetRouter(ctx: AppContext, token: string | undefined): Promise<Router> {
  if (token !== undefined) return ctx.service.resolve(token);
  if (!isInteractive()) {
    throw new RouterFlipError('BAD_USAGE', 'Which router? `models` needs a router name or id.', {
      hint: 'Example: routerflip models GoRouter',
      exitCode: 2,
    });
  }
  return pickRouter(ctx, 'Models of which router?');
}

/**
 * The account whose selection a verb acts on.
 *
 * `--account` wins; otherwise the router's selected account, because that is the
 * pair a launch would use. Asking is reserved for the case where there is a real
 * choice and a terminal to ask on.
 */
async function targetAccount(ctx: AppContext, router: Router): Promise<Account> {
  const named = ctx.flags.str('account');
  if (named !== undefined) return ctx.service.resolveAccount(router, named);
  if (router.accounts.length === 0) {
    throw new RouterFlipError('ROUTER_NOT_FOUND', `"${router.name}" has no accounts yet.`, {
      hint: `Add one with \`routerflip accounts ${router.name} add\`.`,
    });
  }
  if (router.accounts.length === 1 || ctx.json || !isInteractive()) {
    const active = ctx.service.activeAccountOf(router);
    if (active) return active;
  }
  return selectAccount(ctx, router, 'Which account should remember the model?');
}

/** JSON projection of the model half of a router. Never touches credentials. */
function modelsJson(ctx: AppContext, router: Router): Record<string, unknown> {
  const account = ctx.service.activeAccountOf(router);
  return {
    ok: true,
    router: router.name,
    models: [...router.models],
    ...(account ? { account: account.name, selected: account.model ?? null } : {}),
    selections: router.accounts.map((entry) => ({
      account: entry.name,
      model: entry.model ?? null,
    })),
  };
}

/** `models <router>` — the router's list, and what each account chose from it. */
function listModels(ctx: AppContext, router: Router): CommandResult {
  if (ctx.json) {
    json(modelsJson(ctx, router));
    return 0;
  }

  const t = theme();
  blank();
  heading(`  ${router.name}`);
  line(`  ${t.dim(router.baseUrl)}`);
  blank();
  if (router.models.length === 0) {
    note(`  ${t.muted('No models are configured, so launches use the provider default.')}`);
    blank();
    note(`  ${t.dim(`Add one with \`routerflip models ${router.name} add "<name>"\`.`)}`);
    return 0;
  }

  line(`  ${t.muted('Models')}`);
  // A model some account has chosen is marked, so the list also answers "which of
  // these is in use?" without a second pass over the accounts below.
  const selected = new Set(router.accounts.flatMap((entry) => (entry.model === undefined ? [] : [entry.model])));
  router.models.forEach((model, index) => {
    const marker = selected.has(model) ? t.success('·') : t.dim('·');
    line(`  ${marker} ${t.text(model)}  ${t.dim(`(${index + 1})`)}`);
  });
  blank();

  // Which account chose what is the interesting part once there is more than one:
  // the list is shared, the selection is not.
  if (router.accounts.length > 0) {
    line(`  ${t.muted('Selected per account')}`);
    for (const entry of router.accounts) {
      line(`  ${t.text(entry.name)}  ${t.dim('·')}  ${entry.model ? t.muted(entry.model) : t.dim('provider default')}`);
    }
    blank();
  }
  return 0;
}

/** `models <router> add "<name>"` — offer a model to every account of the router. */
function addModel(ctx: AppContext, router: Router, name: string | undefined): CommandResult {
  if (name === undefined) {
    throw new RouterFlipError('BAD_USAGE', 'Which model should be added?', {
      hint: `Name it, for example: routerflip models ${router.name} add "Opus 4.8"`,
      exitCode: 2,
    });
  }
  const { router: updated, model } = ctx.service.addModel(router.id, name);

  if (ctx.json) {
    json(modelsJson(ctx, updated));
    return 0;
  }
  blank();
  success(`"${model}" is now offered by "${updated.name}".`);
  blank();
  note(`  ${theme().dim(`Select it with \`routerflip models ${updated.name} use "${model}"\`.`)}`);
  return 0;
}

/**
 * `models <router> remove "<name>"` — withdraw a model.
 *
 * Confirmation is required because this also clears the selection of every account
 * that had chosen it: those accounts fall back to the provider default rather than
 * remembering something the picker can no longer show.
 */
async function removeModel(ctx: AppContext, router: Router, name: string | undefined): Promise<CommandResult> {
  if (name === undefined) {
    throw new RouterFlipError('BAD_USAGE', 'Which model should be removed?', {
      hint: `Name it, for example: routerflip models ${router.name} remove "Opus 4.8"`,
      exitCode: 2,
    });
  }
  const model = ctx.service.resolveModel(router, name);
  const chosenBy = router.accounts.filter((entry) => entry.model === model).map((entry) => entry.name);

  const approved = await confirmAction(ctx, {
    message: `Remove model "${model}" from "${router.name}"?`,
    details:
      chosenBy.length > 0
        ? [
            `${chosenBy.join(', ')} ${chosenBy.length === 1 ? 'has' : 'have'} it selected and will fall back to the provider default.`,
          ]
        : ['No account has it selected.'],
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!approved) {
    if (!ctx.json) note('  Nothing was removed.');
    return 0;
  }

  const { router: updated } = ctx.service.removeModel(router.id, model);
  if (ctx.json) {
    json(modelsJson(ctx, updated));
    return 0;
  }
  blank();
  success(`"${model}" is no longer offered by "${updated.name}".`);
  return 0;
}

/** `models <router> use "<name>"` — remember it for one account. */
async function useModel(ctx: AppContext, router: Router, name: string | undefined): Promise<CommandResult> {
  const account = await targetAccount(ctx, router);

  let chosen: string;
  if (name !== undefined) {
    // An unknown name is an error rather than a new entry: `use` selects from what
    // the router offers, and `add` is how the list grows.
    chosen = ctx.service.resolveModel(router, name);
  } else if (router.models.length === 0) {
    throw new RouterFlipError('ROUTER_NOT_FOUND', `"${router.name}" has no models configured yet.`, {
      hint: `Add one with \`routerflip models ${router.name} add "<name>"\`.`,
    });
  } else if (!isInteractive() || ctx.json) {
    throw new RouterFlipError('BAD_USAGE', 'Which model should this account use?', {
      hint: `Name it, for example: routerflip models ${router.name} use "${router.models[0]}"`,
      exitCode: 2,
    });
  } else {
    chosen = await select<string>({
      message: `Which model should "${account.name}" use?`,
      options: router.models.map((model) => ({
        label: model,
        value: model,
        ...(model === account.model ? { hint: '(current)' } : {}),
      })),
      initial: Math.max(0, router.models.indexOf(account.model ?? '')),
    });
  }

  const { router: updated, model } = ctx.service.setAccountModel(router.id, account.id, chosen);
  if (ctx.json) {
    json(modelsJson(ctx, updated));
    return 0;
  }
  blank();
  success(`"${account.name}" of "${updated.name}" now launches with ${model}.`);
  return 0;
}

/** `models <router> clear` — go back to the provider's own default. */
async function clearModel(ctx: AppContext, router: Router): Promise<CommandResult> {
  const account = await targetAccount(ctx, router);
  const { router: updated } = ctx.service.setAccountModel(router.id, account.id, undefined);

  if (ctx.json) {
    json(modelsJson(ctx, updated));
    return 0;
  }
  blank();
  success(`"${account.name}" of "${updated.name}" now launches with the provider default.`);
  return 0;
}

/**
 * The grammar: `models [router] [verb] [model]`.
 *
 * Mirrors `accounts` deliberately, including that a leading verb means the router
 * was not named — so `routerflip models add "Opus 4.8"` asks which router rather
 * than treating `add` as one.
 */
function parse(ctx: AppContext): { router?: string; verb?: Verb; model?: string } {
  const tokens = [...ctx.positionals];
  const flagRouter = ctx.flags.str('router');
  const router = flagRouter ?? (isVerb(tokens[0]) ? undefined : tokens.shift());

  let verb: Verb | undefined;
  if (isVerb(tokens[0])) {
    verb = tokens[0];
    tokens.shift();
  } else if (tokens[0] !== undefined) {
    throw new RouterFlipError('BAD_USAGE', `Unknown model action "${tokens[0]}".`, {
      hint: 'Try one of: list, add, remove, use, clear.',
      exitCode: 2,
    });
  }

  const model = tokens[0] ?? ctx.flags.str('model');
  return {
    ...(router === undefined ? {} : { router }),
    ...(verb ? { verb } : {}),
    ...(model === undefined ? {} : { model }),
  };
}

export async function modelsCommand(ctx: AppContext): Promise<CommandResult> {
  const { router: token, verb, model } = parse(ctx);
  const router = await targetRouter(ctx, token);

  switch (verb) {
    case 'add':
      return addModel(ctx, router, model);
    case 'remove':
    case 'delete':
    case 'rm':
      return removeModel(ctx, router, model);
    case 'use':
    case 'select':
      return useModel(ctx, router, model);
    case 'clear':
    case 'none':
      return clearModel(ctx, router);
    default:
      // `models <router> "<name>"` with no verb is a selection: the shortest thing
      // to type is the thing people do most often.
      return model === undefined ? listModels(ctx, router) : useModel(ctx, router, model);
  }
}

// ── The interactive picker ──────────────────────────────────────────────────
//
// Opened by `M` from the `use` action screen and from the dashboard's account
// screen. It is a `select` prompt, which is what makes the keyboard requirement
// structural: `M` is only ever a hotkey of a *select*, and a text prompt hands
// every printable key to its editor (see `LineEditor.handle`), so nothing here can
// fire while a name or a key is being typed.

/** What one turn of the picker resolved to. */
type PickerChoice =
  | { readonly kind: 'model'; readonly model: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'add' }
  | { readonly kind: 'back' };

export interface ChooseModelResult {
  /** True when the account's remembered selection changed. */
  readonly changed: boolean;
  /** The model now remembered, or undefined for the provider default. */
  readonly model?: string;
  /** One line describing what happened, for the caller's status area. */
  readonly status?: string;
}

function pickerOptions(router: Router, account: Account): SelectOption<PickerChoice>[] {
  const out: SelectOption<PickerChoice>[] = router.models.map((model) => ({
    label: model,
    value: { kind: 'model', model },
    ...(model === account.model ? { hint: '(current)' } : {}),
  }));
  out.push({ label: 'Add a model…', value: { kind: 'add' }, detail: "Offer another model on this router's list." });
  // Only worth offering when there is something to clear; a router that has never
  // pinned a model is already on the provider default.
  if (account.model !== undefined) {
    out.push({ label: 'Provider default', value: { kind: 'none' }, detail: 'Launch without pinning a model.' });
  }
  out.push({ label: 'Back', value: { kind: 'back' }, shortcut: 'b' });
  return out;
}

/**
 * The `SELECT MODEL` screen.
 *
 * Returns to whatever screen opened it — the caller redraws — and never forces a
 * choice: `Back`, `Esc` and the `B` shortcut all leave the remembered selection
 * exactly as it was. Every branch settles in one turn, so changing a model is a
 * keypress and an Enter rather than a walk through screens.
 */
export async function chooseModel(ctx: AppContext, router: Router, account: Account): Promise<ChooseModelResult> {
  const t = theme();
  const current = ctx.service.resolve(router.id);
  const chosen = ctx.service.resolveAccount(current, account.id);

  blank();
  for (const row of box([], { width: terminalWidth(), title: 'SELECT MODEL' })) line(row);
  blank();

  const choice = await select<PickerChoice>({
    message: current.models.length === 0 ? 'No models yet — add the first one?' : 'Which model?',
    options: pickerOptions(current, chosen),
    initial: Math.max(0, current.models.indexOf(chosen.model ?? '')),
    details: [
      `  ${t.muted('Router')}   ${t.text(current.name)}`,
      `  ${t.muted('Account')}  ${t.text(chosen.name)}`,
      `  ${t.muted('Current')}  ${chosen.model ? t.text(chosen.model) : t.dim('no model selected')}`,
    ],
    help: 'Enter select   B back   Esc cancel',
  });

  if (choice.kind === 'back') return { changed: false, ...(chosen.model ? { model: chosen.model } : {}) };

  if (choice.kind === 'add') {
    const name = await text({
      message: 'Model name',
      placeholder: 'for example: Opus 4.8',
      validate: (value) => {
        try {
          ctx.service.assertModelValid(value);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : 'Invalid model name.';
        }
      },
      help: "Added to this router's list, so every account of it can choose the model.",
    });
    // Registering it and selecting it is one step: someone who just typed a model
    // name meant to use it, and the list is the router's either way.
    const applied = ctx.service.setAccountModel(current.id, chosen.id, name);
    const model = applied.model ?? name;
    blank();
    success(`Model changed to ${model}.`);
    return { changed: true, model, status: `Model: ${model}` };
  }

  if (choice.kind === 'none') {
    const applied = ctx.service.setAccountModel(current.id, chosen.id, undefined);
    blank();
    success('Model cleared — launches use the provider default.');
    return { changed: true, status: `${applied.account.name} uses the provider default.` };
  }

  // Re-picking what is already remembered is not a change, so the caller is not
  // asked to announce something that did not happen.
  if (choice.model === chosen.model) return { changed: false, model: choice.model };

  ctx.service.setAccountModel(current.id, chosen.id, choice.model);
  blank();
  success(`Model changed to ${choice.model}.`);
  return { changed: true, model: choice.model, status: `Model: ${choice.model}` };
}
