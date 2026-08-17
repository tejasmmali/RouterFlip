/**
 * Account helpers.
 *
 * Pure functions over a `Router`, kept apart from `RouterService` so the renderers,
 * the provider and the launcher can answer "which credential does this pair use?"
 * without owning a service or touching config.json.
 *
 * One rule underpins all of them: **the router owns the base URL, the account owns
 * the key.** Nothing here reads or returns a secret — only the *reference* to one.
 */
import { accountCredentialRefFor, credentialRefFor, sameName, uniqueId } from './id.ts';
import { modelNameProblem, type Account, type Router } from './schema.ts';

/**
 * Name given to a router's first account — both when a router is created and when
 * a version 1 profile's single credential is wrapped in one.
 */
export const FIRST_ACCOUNT_NAME = 'Account 1';

/**
 * The account a router acts as when none was named.
 *
 * Falls back to the first account so a config whose `activeAccount` points at a
 * deleted entry still works — dangling selections are ignored on read rather than
 * repaired by a write, because loading a config must not rewrite it.
 */
export function activeAccount(router: Router): Account | undefined {
  const selected = router.accounts.find((account) => account.id === router.activeAccount);
  return selected ?? router.accounts[0];
}

/**
 * The credential-store entry a router + account pair authenticates with.
 *
 * The fallback to `router.credentialRef` is what keeps a router with no accounts
 * — one whose last account was deleted, or a hand-written profile — working
 * exactly as it did before accounts existed.
 */
export function credentialRefOf(router: Router, account?: Account): string {
  return (account ?? activeAccount(router))?.credentialRef ?? router.credentialRef;
}

/** Every ref a router owns. Used for batch presence lookups and for deletion. */
export function credentialRefsOf(router: Router): readonly string[] {
  return [...new Set([router.credentialRef, ...router.accounts.map((account) => account.credentialRef)])];
}

/**
 * Looks an account up by id, then name, then 1-based position.
 *
 * The positional form is what makes `--account 2` work, matching the numbering the
 * account screen and `routerflip accounts` print.
 */
export function findAccount(router: Router, nameOrId: string): Account | undefined {
  const needle = nameOrId.trim();
  if (needle.length === 0) return undefined;
  const named =
    router.accounts.find((account) => account.id === needle) ??
    router.accounts.find((account) => sameName(account.name, needle)) ??
    router.accounts.find((account) => account.id.toLowerCase() === needle.toLowerCase());
  if (named) return named;
  return /^\d+$/.test(needle) ? router.accounts[Number(needle) - 1] : undefined;
}

/**
 * Mints the id and credential ref for a new account.
 *
 * The first account of a router adopts the router's own ref. That is the whole
 * reason the version 1 → 2 migration never has to move a secret, and it means
 * re-adding an account to an emptied router reuses the slot rather than leaving
 * `router.credentialRef` permanently dangling.
 */
export function nextAccountIdentity(router: Router, name: string): { readonly id: string; readonly credentialRef: string } {
  const id = uniqueId(
    name,
    router.accounts.map((account) => account.id),
    'account',
  );
  return {
    id,
    credentialRef: router.accounts.length === 0 ? credentialRefFor(router.id) : accountCredentialRefFor(router.id, id),
  };
}

/** How an account is named in errors and prompts: "GoRouter / Account 2". */
export function accountLabel(router: Router, account: Account): string {
  return `${router.name} / ${account.name}`;
}

// ── Models ──────────────────────────────────────────────────────────────────
//
// The list of models belongs to the *router*: it describes what the endpoint
// serves, so every account of that router offers the same choices. Which one was
// chosen last is remembered on the *account*, because that is a preference of the
// credential's owner. Neither is a secret, so both live in config.json.

/**
 * Resolves a model the way `findAccount` resolves an account: exact text, then
 * case-insensitively, then by the 1-based position the picker prints.
 *
 * Returns the *stored* spelling, so `--model gpt-5.6` selects `GPT-5.6` rather
 * than adding a second entry that differs only in case.
 */
export function findModel(router: Router, nameOrPosition: string): string | undefined {
  const needle = nameOrPosition.trim();
  if (needle.length === 0) return undefined;
  const named =
    router.models.find((model) => model === needle) ?? router.models.find((model) => sameName(model, needle));
  if (named !== undefined) return named;
  return /^\d+$/.test(needle) ? router.models[Number(needle) - 1] : undefined;
}

/** The list with `model` appended, or unchanged when it is already there. */
export function withModel(models: readonly string[], model: string): readonly string[] {
  return models.some((existing) => sameName(existing, model)) ? models : [...models, model];
}

/**
 * One model as a gateway describes it: the id it accepts, and a label when it
 * offers one worth showing. `id` is the only half ever sent to Claude Code.
 */
export interface DiscoveredModel {
  readonly id: string;
  readonly name?: string;
}

/** How a model is shown to a human: its label when it has one, else the id. */
export function modelLabel(router: Router, model: string): string {
  return router.modelNames[model] ?? model;
}

/**
 * A gateway lists what it serves and RouterFlip believes it — but never at the
 * cost of what the user typed. Nothing gets deleted here: a model that vanished
 * from the listing may still be real, and an account may still have it selected,
 * so the discovered ids come first (in the order the gateway gave them) and
 * anything only the user knows about is kept after them.
 *
 * Deduplication is by model id, case-insensitively, keeping the spelling already
 * on disk so an account's remembered selection still matches after a refresh.
 * ponytail: capped at MAX_MODELS; a gateway that lists more is almost certainly
 * broken, and config.json is not a cache.
 */
export function mergeModels(
  router: Router,
  discovered: readonly DiscoveredModel[],
): { readonly models: string[]; readonly modelNames: Record<string, string> } {
  const models: string[] = [];
  const modelNames: Record<string, string> = {};
  const add = (id: string, name?: string): void => {
    if (models.length >= MAX_MODELS || models.some((existing) => sameName(existing, id))) return;
    // The listing is untrusted input on its way to config.json and to a child
    // process's environment, so it is held to the same rule as a typed name.
    if (id.length === 0 || id.length > 100 || modelNameProblem(id) !== undefined) return;
    models.push(id);
    if (name !== undefined && name.length > 0 && name !== id && modelNameProblem(name) === undefined) {
      modelNames[id] = name.slice(0, 100);
    }
  };

  for (const entry of discovered) {
    const id = entry.id.trim();
    const known = router.models.find((existing) => sameName(existing, id));
    add(known ?? id, entry.name?.trim());
  }
  for (const model of router.models) add(model, router.modelNames[model]);
  return { models, modelNames };
}

/** A gateway with more models than this is not worth persisting in full. */
const MAX_MODELS = 500;
