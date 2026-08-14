/**
 * Credential store selection.
 *
 * Preference order per platform, best first:
 *   Windows  DPAPI  → encrypted file
 *   macOS    Keychain → encrypted file
 *   Linux    Secret Service → encrypted file
 *
 * The chosen backend is resolved lazily and cached for the process. Reads that
 * miss the primary backend fall back to searching the other backends, so a user
 * who switches machines, installs a keyring later, or overrides the backend in
 * config.json does not lose access to keys already stored.
 */
import { RouterFlipError, describeCause } from '../errors.ts';
import { logger } from '../logger.ts';
import { createDpapiStore } from './dpapi.ts';
import { createFileStore } from './file.ts';
import { createKeychainStore } from './keychain.ts';
import { createSecretServiceStore } from './secretservice.ts';
import type { BackendId, CredentialStore } from './types.ts';
import type { CredentialBackendChoice } from '../core/schema.ts';

export type { BackendId, CredentialStore } from './types.ts';

function factoryFor(id: BackendId): CredentialStore {
  switch (id) {
    case 'keychain':
      return createKeychainStore();
    case 'secret-service':
      return createSecretServiceStore();
    case 'dpapi':
      return createDpapiStore();
    case 'file':
      return createFileStore();
  }
}

function preferenceOrder(): BackendId[] {
  if (process.platform === 'win32') return ['dpapi', 'file'];
  if (process.platform === 'darwin') return ['keychain', 'file'];
  return ['secret-service', 'file'];
}

export interface ResolvedBackend {
  readonly store: CredentialStore;
  /** Backends that were tried and rejected, for `doctor` output. */
  readonly rejected: readonly { id: BackendId; reason: string }[];
}

/** Resolves the backend to use. `choice` comes from config.settings. */
export async function resolveBackend(choice: CredentialBackendChoice = 'auto'): Promise<ResolvedBackend> {
  const rejected: { id: BackendId; reason: string }[] = [];

  if (choice !== 'auto') {
    const store = factoryFor(choice);
    if (await store.isAvailable()) return { store, rejected };
    throw new RouterFlipError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      `The configured credential backend "${choice}" is not available on this machine.`,
      { hint: 'Set "settings.credentialBackend" to "auto" in config.json, or install the backend.' },
    );
  }

  for (const id of preferenceOrder()) {
    const store = factoryFor(id);
    try {
      if (await store.isAvailable()) {
        logger.debug(`credentials: using ${id} backend`);
        return { store, rejected };
      }
      rejected.push({ id, reason: 'not available on this system' });
    } catch (error) {
      rejected.push({ id, reason: describeCause(error) });
    }
  }

  // preferenceOrder always ends in 'file', whose isAvailable() is always true.
  throw new RouterFlipError('CREDENTIAL_STORE_UNAVAILABLE', 'No credential storage backend is available.', {
    hint: 'This should not happen — please report it with the output of `routerflip doctor --verbose`.',
  });
}

/**
 * Process-wide credential facade. Wraps backend errors into RouterFlipError,
 * caches reads (a single `use` may read the same key three times), and never
 * includes secret values in any thrown message.
 */
export class Credentials {
  #choice: CredentialBackendChoice;
  #resolved: ResolvedBackend | undefined;
  #cache = new Map<string, string | undefined>();

  constructor(choice: CredentialBackendChoice = 'auto') {
    this.#choice = choice;
  }

  async backend(): Promise<CredentialStore> {
    return (await this.resolved()).store;
  }

  async resolved(): Promise<ResolvedBackend> {
    this.#resolved ??= await resolveBackend(this.#choice);
    return this.#resolved;
  }

  /** Returns the secret, or undefined when the ref has no stored key. */
  async get(ref: string): Promise<string | undefined> {
    if (this.#cache.has(ref)) return this.#cache.get(ref);
    const primary = await this.backend();
    let value: string | undefined;
    try {
      value = await primary.get(ref);
    } catch (error) {
      throw new RouterFlipError('CREDENTIAL_READ_FAILED', `Could not read the stored key for "${ref}".`, {
        hint: describeCause(error),
        cause: error,
      });
    }
    value ??= await this.#searchOtherBackends(ref, primary.id);
    this.#cache.set(ref, value);
    return value;
  }

  /** Like `get`, but fails loudly — used wherever a key is actually required. */
  async require(ref: string, routerName: string): Promise<string> {
    const value = await this.get(ref);
    if (!value) {
      const store = await this.backend();
      throw new RouterFlipError('CREDENTIAL_MISSING', `No API key is stored for "${routerName}".`, {
        hint: `Run \`routerflip edit ${routerName}\` to set it. (Looked in: ${store.label}.)`,
      });
    }
    return value;
  }

  async set(ref: string, secret: string): Promise<void> {
    const store = await this.backend();
    try {
      await store.set(ref, secret);
    } catch (error) {
      throw new RouterFlipError('CREDENTIAL_WRITE_FAILED', `Could not save the API key to ${store.label}.`, {
        hint: describeCause(error),
        cause: error,
      });
    }
    this.#cache.set(ref, secret);
  }

  async remove(ref: string): Promise<void> {
    const store = await this.backend();
    try {
      await store.remove(ref);
    } catch (error) {
      logger.debug(`credentials: remove failed for ${ref}: ${describeCause(error)}`);
    }
    // Remove from the other backends too, so `delete` never leaves a key behind.
    for (const id of preferenceOrder()) {
      if (id === store.id) continue;
      try {
        const other = factoryFor(id);
        if (await other.isAvailable()) await other.remove(ref);
      } catch {
        /* best effort */
      }
    }
    this.#cache.delete(ref);
  }

  /** Batch existence check for `doctor` — returns refs that have a stored key. */
  async presence(refs: readonly string[]): Promise<Map<string, boolean>> {
    const store = await this.backend();
    const out = new Map<string, boolean>();
    if (store.getMany) {
      const found = await store.getMany(refs);
      for (const ref of refs) {
        const value = found.get(ref);
        this.#cache.set(ref, value);
        out.set(ref, Boolean(value));
      }
      return out;
    }
    for (const ref of refs) out.set(ref, Boolean(await this.get(ref)));
    return out;
  }

  async #searchOtherBackends(ref: string, skip: BackendId): Promise<string | undefined> {
    for (const id of preferenceOrder()) {
      if (id === skip) continue;
      try {
        const store = factoryFor(id);
        if (!(await store.isAvailable())) continue;
        const value = await store.get(ref);
        if (value) {
          logger.debug(`credentials: found ${ref} in fallback backend ${id}`);
          return value;
        }
      } catch {
        /* a fallback that errors is simply not a source */
      }
    }
    return undefined;
  }
}
