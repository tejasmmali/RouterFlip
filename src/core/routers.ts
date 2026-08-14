/**
 * Router profile service.
 *
 * The single place that mutates config.json, so every rule the CLI promises —
 * unique names, normalized URLs, trimmed input, keys stored out-of-band — is
 * enforced once rather than in each command.
 */
import { RouterFlipError } from '../errors.ts';
import { logger } from '../logger.ts';
import type { Credentials } from '../credentials/index.ts';
import { credentialRefFor, normalizeName, nowIso, sameName, uniqueId } from './id.ts';
import { maskSecret } from './mask.ts';
import { loadConfig, loadState, saveConfig, saveState } from './store.ts';
import { routerNameProblem, type AuthEnvVar, type Config, type ProviderId, type Router } from './schema.ts';
import { normalizeUrl } from './url.ts';

export interface NewRouterInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly description?: string;
  readonly provider?: ProviderId;
  readonly authEnvVar?: AuthEnvVar;
  readonly testPath?: string;
}

export interface RouterPatch {
  readonly name?: string;
  readonly baseUrl?: string;
  /** Omit to leave the stored key untouched. */
  readonly apiKey?: string;
  readonly description?: string;
  readonly authEnvVar?: AuthEnvVar;
  readonly testPath?: string;
}

/** Safe-to-print projection of a router. Used by every renderer and --json. */
export interface RouterView {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly description: string;
  readonly maskedKey: string;
  readonly hasKey: boolean;
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
    const router: Router = {
      id,
      name,
      baseUrl: url,
      credentialRef: credentialRefFor(id),
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
    await this.#credentials.set(router.credentialRef, apiKey);
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
      await this.#credentials.set(existing.credentialRef, apiKey);
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

  /** Removes the profile and its stored key. */
  async remove(id: string): Promise<Router> {
    const existing = this.resolve(id);
    await this.#credentials.remove(existing.credentialRef);

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

  /** Loads the key for a router, failing with a friendly message when absent. */
  async apiKey(router: Router): Promise<string> {
    const key = await this.#credentials.require(router.credentialRef, router.name);
    logger.protect(key);
    return key;
  }

  async hasKey(router: Router): Promise<boolean> {
    return Boolean(await this.#credentials.get(router.credentialRef));
  }

  /** Builds a print-safe view. `maskedKey` is a mask even when no key exists. */
  async view(router: Router): Promise<RouterView> {
    const key = await this.#credentials.get(router.credentialRef);
    if (key) logger.protect(key);
    return {
      id: router.id,
      name: router.name,
      baseUrl: router.baseUrl,
      description: router.description,
      maskedKey: maskSecret(key),
      hasKey: Boolean(key),
      authEnvVar: router.authEnvVar,
      provider: router.provider,
      isActive: this.#config.activeRouter === router.id,
      createdAt: router.createdAt,
      updatedAt: router.updatedAt,
    };
  }

  async views(): Promise<RouterView[]> {
    const refs = this.#config.routers.map((router) => router.credentialRef);
    await this.#credentials.presence(refs); // warms the cache in one batch
    return Promise.all(this.#config.routers.map((router) => this.view(router)));
  }
}
