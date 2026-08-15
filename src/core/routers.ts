/**
 * Router profile service.
 *
 * The single place that mutates config.json, so every rule the CLI promises —
 * unique names, normalized URLs, trimmed input, keys stored out-of-band — is
 * enforced once rather than in each command.
 *
 * A router owns a base URL and a list of accounts; each account owns one key in
 * the OS credential store. Every read that needs a key goes through
 * `credentialRefOf`, so "which account?" is answered in exactly one place and a
 * router with no accounts keeps behaving as it did before they existed.
 */
import { RouterFlipError } from '../errors.ts';
import { logger } from '../logger.ts';
import type { Credentials } from '../credentials/index.ts';
import {
  FIRST_ACCOUNT_NAME,
  accountLabel,
  activeAccount,
  credentialRefOf,
  credentialRefsOf,
  findAccount,
  findModel,
  nextAccountIdentity,
  withModel,
} from './accounts.ts';
import { credentialRefFor, normalizeName, nowIso, sameName, uniqueId } from './id.ts';
import { maskSecret } from './mask.ts';
import { loadConfig, loadState, saveConfig, saveState } from './store.ts';
import {
  accountNameProblem,
  modelNameProblem,
  routerNameProblem,
  type Account,
  type AuthEnvVar,
  type Config,
  type ProviderId,
  type Router,
} from './schema.ts';
import { normalizeUrl } from './url.ts';

export interface NewRouterInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly description?: string;
  readonly provider?: ProviderId;
  readonly authEnvVar?: AuthEnvVar;
  readonly testPath?: string;
  /** Name for the account the key is stored under. Defaults to "Account 1". */
  readonly accountName?: string;
}

export interface RouterPatch {
  readonly name?: string;
  readonly baseUrl?: string;
  /** Omit to leave the stored key untouched. Applies to the selected account. */
  readonly apiKey?: string;
  readonly description?: string;
  readonly authEnvVar?: AuthEnvVar;
  readonly testPath?: string;
}

export interface NewAccountInput {
  readonly name: string;
  readonly apiKey: string;
  readonly description?: string;
}

export interface AccountPatch {
  readonly name?: string;
  /** Omit to leave the stored key untouched. */
  readonly apiKey?: string;
  readonly description?: string;
}

/** Safe-to-print projection of one account. Never carries the key itself. */
export interface AccountView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly maskedKey: string;
  readonly hasKey: boolean;
  /** True when this is the account the router will authenticate with. */
  readonly isActive: boolean;
  /** Model this account last chose, if any. Absent means "the provider default". */
  readonly model?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Safe-to-print projection of a router. Used by every renderer and --json. */
export interface RouterView {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly description: string;
  /** Mask of the *selected* account's key, so one line always shows what will be used. */
  readonly maskedKey: string;
  readonly hasKey: boolean;
  readonly accountCount: number;
  readonly activeAccountId?: string;
  readonly activeAccountName?: string;
  /** Models this router offers, shared by all of its accounts. */
  readonly models: readonly string[];
  /** Model the *selected* account would launch with, if it has chosen one. */
  readonly model?: string;
  readonly authEnvVar: AuthEnvVar;
  readonly provider: ProviderId;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class RouterService {
  #config: Config;
  readonly #credentials: Credentials;

  constructor(credentials: Credentials, config: Config = loadConfig()) {
    this.#credentials = credentials;
    this.#config = config;
  }

  get config(): Config {
    return this.#config;
  }

  list(): readonly Router[] {
    return this.#config.routers;
  }

  get activeId(): string | undefined {
    return this.#config.activeRouter;
  }

  isEmpty(): boolean {
    return this.#config.routers.length === 0;
  }

  /** Looks up by id first, then by case-insensitive name. */
  find(nameOrId: string): Router | undefined {
    const needle = nameOrId.trim();
    if (needle.length === 0) return undefined;
    return (
      this.#config.routers.find((router) => router.id === needle) ??
      this.#config.routers.find((router) => sameName(router.name, needle)) ??
      this.#config.routers.find((router) => router.id.toLowerCase() === needle.toLowerCase())
    );
  }

  /** Like `find`, but throws a helpful error listing near matches. */
  resolve(nameOrId: string): Router {
    const found = this.find(nameOrId);
    if (found) return found;
    if (this.isEmpty()) {
      throw new RouterFlipError('NO_ROUTERS', 'No routers are configured yet.', {
        hint: 'Add your first gateway with `routerflip add`.',
      });
    }
    const needle = nameOrId.trim().toLowerCase();
    const near = this.#config.routers
      .filter((router) => router.name.toLowerCase().includes(needle) || router.id.includes(needle))
      .map((router) => router.name);
    const known = this.#config.routers.map((router) => router.name).join(', ');
    throw new RouterFlipError('ROUTER_NOT_FOUND', `No router named "${nameOrId}".`, {
      hint: near.length > 0 ? `Did you mean: ${near.join(', ')}?` : `Configured routers: ${known}`,
    });
  }

  /** Throws when `name` is already taken by a different router. */
  assertNameAvailable(name: string, exceptId?: string): void {
    const problem = routerNameProblem(normalizeName(name));
    if (problem) throw new RouterFlipError('ROUTER_INVALID', problem);
    const clash = this.#config.routers.find((router) => sameName(router.name, name) && router.id !== exceptId);
    if (clash) {
      throw new RouterFlipError('ROUTER_DUPLICATE', `A router named "${clash.name}" already exists.`, {
        hint: `Pick a different name, or edit the existing one with \`routerflip edit ${clash.name}\`.`,
      });
    }
  }

  async add(input: NewRouterInput): Promise<Router> {
    const name = normalizeName(input.name);
    if (name.length === 0) {
      throw new RouterFlipError('ROUTER_INVALID', 'Router name is required.');
    }
    this.assertNameAvailable(name);

    const apiKey = input.apiKey.trim();
    if (apiKey.length === 0) {
      throw new RouterFlipError('ROUTER_INVALID', 'An API key is required.', {
        hint: 'The key is stored in your operating system credential store, not in config.json.',
      });
    }

    const { url } = normalizeUrl(input.baseUrl);
    const id = uniqueId(name, this.#config.routers.map((router) => router.id));
    const timestamp = nowIso();
    // A new router is created in the shape a migrated one ends up in: one account,
    // selected, holding the key under the router's own ref.
    const accountName = normalizeName(input.accountName ?? FIRST_ACCOUNT_NAME) || FIRST_ACCOUNT_NAME;
    const account: Account = {
      id: uniqueId(accountName, [], 'account'),
      name: accountName,
      credentialRef: credentialRefFor(id),
      description: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const router: Router = {
      id,
      name,
      baseUrl: url,
      credentialRef: credentialRefFor(id),
      accounts: [account],
      activeAccount: account.id,
      // No models are assumed: choosing one is optional, and a router starts out
      // launching with whatever default the provider already has.
      models: [],
      description: (input.description ?? '').trim(),
      provider: input.provider ?? 'claude-code',
      authEnvVar: input.authEnvVar ?? 'ANTHROPIC_API_KEY',
      ...(input.testPath ? { testPath: input.testPath } : {}),
      metadata: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // Store the credential first: a config entry pointing at a key that was
    // never saved is the one inconsistency users cannot fix themselves.
    await this.#credentials.set(account.credentialRef, apiKey);
    logger.protect(apiKey);

    this.#config = {
      ...this.#config,
      routers: [...this.#config.routers, router],
      activeRouter: this.#config.activeRouter ?? router.id,
    };
    saveConfig(this.#config);
    logger.debug(`router added: ${router.id}`);
    return router;
  }

  async update(id: string, patch: RouterPatch): Promise<Router> {
    const existing = this.resolve(id);
    const name = patch.name === undefined ? existing.name : normalizeName(patch.name);
    if (name !== existing.name) this.assertNameAvailable(name, existing.id);

    const baseUrl = patch.baseUrl === undefined ? existing.baseUrl : normalizeUrl(patch.baseUrl).url;

    if (patch.apiKey !== undefined) {
      const apiKey = patch.apiKey.trim();
      if (apiKey.length === 0) {
        throw new RouterFlipError('ROUTER_INVALID', 'An API key cannot be empty.');
      }
      // Router-level edits act on the selected account, which is the one every
      // launch would have used anyway.
      await this.#credentials.set(credentialRefOf(existing), apiKey);
      logger.protect(apiKey);
    }

    const updated: Router = {
      ...existing,
      name,
      baseUrl,
      description: patch.description === undefined ? existing.description : patch.description.trim(),
      authEnvVar: patch.authEnvVar ?? existing.authEnvVar,
      ...(patch.testPath === undefined ? {} : { testPath: patch.testPath }),
      updatedAt: nowIso(),
    };

    this.#config = {
      ...this.#config,
      routers: this.#config.routers.map((router) => (router.id === existing.id ? updated : router)),
    };
    saveConfig(this.#config);
    logger.debug(`router updated: ${updated.id}`);
    return updated;
  }

  /** Removes the profile and every key any of its accounts stored. */
  async remove(id: string): Promise<Router> {
    const existing = this.resolve(id);
    for (const ref of credentialRefsOf(existing)) await this.#credentials.remove(ref);

    const remaining = this.#config.routers.filter((router) => router.id !== existing.id);
    this.#config = {
      ...this.#config,
      routers: remaining,
      ...(this.#config.activeRouter === existing.id
        ? { activeRouter: remaining[0]?.id }
        : {}),
    };
    saveConfig(this.#config);

    // A deleted router must not stay referenced by the activation record.
    const state = loadState();
    if (state.activation?.routerId === existing.id) {
      saveState({ ...state, activation: undefined });
    }
    logger.debug(`router removed: ${existing.id}`);
    return existing;
  }

  setActive(id: string): Router {
    const router = this.resolve(id);
    this.#config = { ...this.#config, activeRouter: router.id };
    saveConfig(this.#config);
    return router;
  }

  /**
   * Loads the key for a router, failing with a friendly message when absent.
   *
   * `account` names which credential to load; omitted, the router's selected
   * account is used — the same choice a launch would make.
   */
  async apiKey(router: Router, account?: Account): Promise<string> {
    const chosen = account ?? activeAccount(router);
    const label = chosen ? accountLabel(router, chosen) : router.name;
    const key = await this.#credentials.require(credentialRefOf(router, account), label);
    logger.protect(key);
    return key;
  }

  async hasKey(router: Router, account?: Account): Promise<boolean> {
    return Boolean(await this.#credentials.get(credentialRefOf(router, account)));
  }

  /**
   * Builds a print-safe view. `maskedKey` is a mask even when no key exists.
   *
   * `account` overrides which account the view describes, so a command that was
   * told `--account` shows the mask of the key it will actually use rather than
   * the one that happens to be selected on disk.
   */
  async view(router: Router, account?: Account): Promise<RouterView> {
    const selected = account ?? activeAccount(router);
    const key = await this.#credentials.get(credentialRefOf(router, selected));
    if (key) logger.protect(key);
    return {
      id: router.id,
      name: router.name,
      baseUrl: router.baseUrl,
      description: router.description,
      maskedKey: maskSecret(key),
      hasKey: Boolean(key),
      accountCount: router.accounts.length,
      ...(selected ? { activeAccountId: selected.id, activeAccountName: selected.name } : {}),
      models: router.models,
      ...(selected?.model ? { model: selected.model } : {}),
      authEnvVar: router.authEnvVar,
      provider: router.provider,
      isActive: this.#config.activeRouter === router.id,
      createdAt: router.createdAt,
      updatedAt: router.updatedAt,
    };
  }

  async views(): Promise<RouterView[]> {
    const refs = this.#config.routers.flatMap((router) => [...credentialRefsOf(router)]);
    await this.#credentials.presence(refs); // warms the cache in one batch
    return Promise.all(this.#config.routers.map((router) => this.view(router)));
  }

  // ── Accounts ──────────────────────────────────────────────────────────────
  //
  // The router owns the base URL; each account owns one credential-store entry.
  // Writes go through `#writeRouter` so there is still exactly one place that
  // saves config.json.

  #writeRouter(updated: Router): void {
    this.#config = {
      ...this.#config,
      routers: this.#config.routers.map((router) => (router.id === updated.id ? updated : router)),
    };
    saveConfig(this.#config);
  }

  accounts(router: Router): readonly Account[] {
    return router.accounts;
  }

  /** The account this router will authenticate with: selected, else the first. */
  activeAccountOf(router: Router): Account | undefined {
    return activeAccount(router);
  }

  /** Looks up by id, name or 1-based position. */
  findAccount(router: Router, nameOrId: string): Account | undefined {
    return findAccount(router, nameOrId);
  }

  /** Like `findAccount`, but throws with the names that do exist. */
  resolveAccount(router: Router, nameOrId: string): Account {
    const found = findAccount(router, nameOrId);
    if (found) return found;
    if (router.accounts.length === 0) {
      throw new RouterFlipError('ROUTER_NOT_FOUND', `"${router.name}" has no accounts yet.`, {
        hint: `Add one with \`routerflip accounts ${router.name}\`.`,
      });
    }
    const known = router.accounts.map((account) => account.name).join(', ');
    throw new RouterFlipError('ROUTER_NOT_FOUND', `"${router.name}" has no account named "${nameOrId}".`, {
      hint: `Accounts: ${known}`,
    });
  }

  /** Throws when `name` is taken by a different account of the same router. */
  assertAccountNameAvailable(router: Router, name: string, exceptId?: string): void {
    const problem = accountNameProblem(normalizeName(name));
    if (problem) throw new RouterFlipError('ROUTER_INVALID', problem);
    const clash = router.accounts.find((account) => sameName(account.name, name) && account.id !== exceptId);
    if (clash) {
      throw new RouterFlipError('ROUTER_DUPLICATE', `"${router.name}" already has an account named "${clash.name}".`, {
        hint: 'Account names have to be unique within a router. Pick a different one.',
      });
    }
  }

  async addAccount(routerId: string, input: NewAccountInput): Promise<Account> {
    const router = this.resolve(routerId);
    const name = normalizeName(input.name) || FIRST_ACCOUNT_NAME;
    this.assertAccountNameAvailable(router, name);

    const apiKey = input.apiKey.trim();
    if (apiKey.length === 0) {
      throw new RouterFlipError('ROUTER_INVALID', 'An API key is required.', {
        hint: 'The key is stored in your operating system credential store, not in config.json.',
      });
    }

    const timestamp = nowIso();
    const { id, credentialRef } = nextAccountIdentity(router, name);
    const account: Account = { id, name, credentialRef, description: (input.description ?? '').trim(), createdAt: timestamp, updatedAt: timestamp };

    // Key first, for the same reason as `add`: a config entry pointing at a
    // credential that was never written is the one state a user cannot repair.
    await this.#credentials.set(account.credentialRef, apiKey);
    logger.protect(apiKey);

    this.#writeRouter({
      ...router,
      accounts: [...router.accounts, account],
      // The first account of a router is selected automatically; later ones are
      // not, so adding an account never silently changes which key is in use.
      ...(router.accounts.length === 0 ? { activeAccount: account.id } : {}),
      updatedAt: timestamp,
    });
    logger.debug(`account added: ${router.id}/${account.id}`);
    return account;
  }

  async updateAccount(routerId: string, accountId: string, patch: AccountPatch): Promise<Account> {
    const router = this.resolve(routerId);
    const existing = this.resolveAccount(router, accountId);
    const name = patch.name === undefined ? existing.name : normalizeName(patch.name);
    if (name !== existing.name) this.assertAccountNameAvailable(router, name, existing.id);

    if (patch.apiKey !== undefined) {
      const apiKey = patch.apiKey.trim();
      if (apiKey.length === 0) throw new RouterFlipError('ROUTER_INVALID', 'An API key cannot be empty.');
      // The ref is derived from the id, which never changes, so renaming an
      // account cannot orphan its key.
      await this.#credentials.set(existing.credentialRef, apiKey);
      logger.protect(apiKey);
    }

    const updated: Account = {
      ...existing,
      name,
      description: patch.description === undefined ? existing.description : patch.description.trim(),
      updatedAt: nowIso(),
    };
    this.#writeRouter({
      ...router,
      accounts: router.accounts.map((account) => (account.id === existing.id ? updated : account)),
      updatedAt: updated.updatedAt,
    });
    logger.debug(`account updated: ${router.id}/${updated.id}`);
    return updated;
  }

  /**
   * Removes an account and the credential-store entry it owned.
   *
   * The key goes first: an account left in config.json is visible and deletable,
   * whereas a credential with nothing referencing it is invisible.
   */
  async removeAccount(routerId: string, accountId: string): Promise<Account> {
    const router = this.resolve(routerId);
    const existing = this.resolveAccount(router, accountId);
    await this.#credentials.remove(existing.credentialRef);

    const remaining = router.accounts.filter((account) => account.id !== existing.id);
    // Never leave the selection pointing at something that is gone: fall to the
    // first survivor, or drop the field when the router has no accounts left.
    const nextActive = router.activeAccount === existing.id ? remaining[0]?.id : router.activeAccount;
    const { activeAccount: _previous, ...rest } = router;
    this.#writeRouter({
      ...rest,
      accounts: remaining,
      ...(nextActive === undefined ? {} : { activeAccount: nextActive }),
      updatedAt: nowIso(),
    });
    logger.debug(`account removed: ${router.id}/${existing.id}`);
    return existing;
  }

  /**
   * Selects a router *and* one of its accounts — the pair a launch needs.
   *
   * Both halves are written together on purpose: an active router whose account
   * belongs to a different router is the one inconsistent state the account screen
   * could otherwise produce.
   */
  setActiveAccount(routerId: string, accountId: string): { readonly router: Router; readonly account: Account } {
    const router = this.resolve(routerId);
    const account = this.resolveAccount(router, accountId);
    this.#config = { ...this.#config, activeRouter: router.id };
    this.#writeRouter({ ...router, activeAccount: account.id });
    const updated = this.resolve(router.id);
    logger.debug(`active account: ${updated.id}/${account.id}`);
    return { router: updated, account };
  }

  /** Print-safe projection of one account. Carries a mask, never a key. */
  async accountView(router: Router, account: Account): Promise<AccountView> {
    const key = await this.#credentials.get(account.credentialRef);
    if (key) logger.protect(key);
    const selected = activeAccount(router);
    return {
      id: account.id,
      name: account.name,
      description: account.description,
      maskedKey: maskSecret(key),
      hasKey: Boolean(key),
      isActive: selected?.id === account.id,
      ...(account.model ? { model: account.model } : {}),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  async accountViews(router: Router): Promise<AccountView[]> {
    await this.#credentials.presence(router.accounts.map((account) => account.credentialRef));
    return Promise.all(router.accounts.map((account) => this.accountView(router, account)));
  }

  // ── Models ────────────────────────────────────────────────────────────────
  //
  // The list belongs to the router (it describes the endpoint) and the selection
  // belongs to the account (it is that credential's last choice). Both are
  // non-secret, so both live in config.json alongside everything else here, and
  // both go through `#writeRouter`.

  /** The model this pair would launch with, or undefined when none was chosen. */
  modelOf(router: Router, account?: Account): string | undefined {
    return (account ?? activeAccount(router))?.model;
  }

  /**
   * Like `findModel`, but throws listing the models that do exist.
   *
   * Used for `--model` on a router whose list does not contain it: guessing would
   * either add an unintended entry or launch with a model the gateway rejects.
   */
  resolveModel(router: Router, nameOrPosition: string): string {
    const found = findModel(router, nameOrPosition);
    if (found !== undefined) return found;
    if (router.models.length === 0) {
      throw new RouterFlipError('ROUTER_NOT_FOUND', `"${router.name}" has no models configured yet.`, {
        hint: `Add this one with \`routerflip models ${router.name} add "${nameOrPosition}"\`.`,
      });
    }
    throw new RouterFlipError('ROUTER_NOT_FOUND', `"${router.name}" has no model called "${nameOrPosition}".`, {
      hint: `Models: ${router.models.join(', ')}`,
    });
  }

  /** Validates a model name the way the schema will when it is saved. */
  assertModelValid(name: string): void {
    const value = normalizeName(name);
    if (value.length === 0) throw new RouterFlipError('ROUTER_INVALID', 'A model name is required.');
    if (value.length > 100) throw new RouterFlipError('ROUTER_INVALID', 'A model name must be at most 100 characters.');
    const problem = modelNameProblem(value);
    if (problem) throw new RouterFlipError('ROUTER_INVALID', problem);
  }

  /**
   * Adds a model to the router's list, or returns it unchanged when an equal name
   * is already there — so offering the same model twice is a no-op rather than a
   * duplicate row in the picker.
   */
  addModel(routerId: string, name: string): { readonly router: Router; readonly model: string } {
    const router = this.resolve(routerId);
    this.assertModelValid(name);
    const model = normalizeName(name);
    const existing = findModel(router, model);
    if (existing !== undefined) return { router, model: existing };
    this.#writeRouter({ ...router, models: [...withModel(router.models, model)], updatedAt: nowIso() });
    const updated = this.resolve(router.id);
    logger.debug(`model added: ${updated.id}/${model}`);
    return { router: updated, model };
  }

  /** Removes a model from the router's list and from every account that chose it. */
  removeModel(routerId: string, name: string): { readonly router: Router; readonly model: string } {
    const router = this.resolve(routerId);
    const model = this.resolveModel(router, name);
    const timestamp = nowIso();
    this.#writeRouter({
      ...router,
      models: router.models.filter((entry) => entry !== model),
      // An account must never be left remembering a model the router no longer
      // offers: it would launch with something the picker cannot show.
      accounts: router.accounts.map((account) => {
        if (account.model !== model) return account;
        const { model: _dropped, ...rest } = account;
        return { ...rest, updatedAt: timestamp };
      }),
      updatedAt: timestamp,
    });
    const updated = this.resolve(router.id);
    logger.debug(`model removed: ${updated.id}/${model}`);
    return { router: updated, model };
  }

  /**
   * Remembers the model an account last chose, adding it to the router's list when
   * it is new. Passing `undefined` clears the selection, which is a legitimate
   * choice: model selection is optional throughout.
   */
  setAccountModel(
    routerId: string,
    accountId: string,
    name: string | undefined,
  ): { readonly router: Router; readonly account: Account; readonly model?: string } {
    const router = this.resolve(routerId);
    const existing = this.resolveAccount(router, accountId);
    const timestamp = nowIso();

    if (name === undefined) {
      const { model: _cleared, ...rest } = existing;
      const account: Account = { ...rest, updatedAt: timestamp };
      this.#writeRouter({
        ...router,
        accounts: router.accounts.map((entry) => (entry.id === account.id ? account : entry)),
        updatedAt: timestamp,
      });
      logger.debug(`model cleared: ${router.id}/${account.id}`);
      return { router: this.resolve(router.id), account };
    }

    this.assertModelValid(name);
    // Selecting a model the router has never offered registers it there too: the
    // list is the router's, so a choice made once is available to its siblings.
    const model = findModel(router, normalizeName(name)) ?? normalizeName(name);
    const account: Account = { ...existing, model, updatedAt: timestamp };
    this.#writeRouter({
      ...router,
      models: [...withModel(router.models, model)],
      accounts: router.accounts.map((entry) => (entry.id === account.id ? account : entry)),
      updatedAt: timestamp,
    });
    logger.debug(`model selected: ${router.id}/${account.id} → ${model}`);
    return { router: this.resolve(router.id), account, model };
  }
}
