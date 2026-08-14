/**
 * Provider abstraction.
 *
 * A "provider" is a CLI that RouterFlip can point at a gateway (v1: Claude Code
 * only). The interface is intentionally narrow and centred on two questions:
 *
 *   - what environment does this tool need in order to talk to a gateway?
 *   - how do I persist that choice *safely*, and undo it later?
 *
 * Keeping those separate is what makes temporary mode risk-free: it only ever
 * uses `envFor`, which touches nothing on disk.
 */
import type { Account, Activation, ProviderId, Router } from '../core/schema.ts';

/** Result of looking for the provider's executable on PATH. */
export interface ProviderDetection {
  readonly found: boolean;
  /** Absolute path, when found. */
  readonly executable?: string;
  /** The name that resolved (e.g. `claude`). */
  readonly command?: string;
  /** Version string, when cheaply obtainable. */
  readonly version?: string;
  /** Why it was not found / what to do about it. */
  readonly hint?: string;
}

/** Environment variables to add for a router. Values may include the API key. */
export type EnvDelta = Readonly<Record<string, string>>;

/**
 * How permanent mode persists the credential.
 *
 *   'env'    — writes the key into the provider's settings file. Simple and
 *              universally supported, but the key sits in a plaintext file.
 *   'helper' — writes a command the provider calls to fetch the key, so the
 *              secret stays in the OS credential store. Requires the
 *              `routerflip` executable to be resolvable on PATH.
 */
export type PermanentStrategy = 'env' | 'helper';

export interface ApplyOptions {
  /** Activation record from a previous apply, so history is carried forward. */
  readonly previous?: Activation;
  readonly strategy?: PermanentStrategy;
  /** Directory for pre-write backups. */
  readonly backupsDir: string;
  /** How many backups of the provider config to keep. */
  readonly backupRetention?: number;
  /**
   * The account whose credential is being applied. Only the helper strategy
   * needs it — the command it writes has to name the account, or a later
   * `use --account` would silently keep serving the old key.
   */
  readonly account?: Account;
}

/** What the provider's persistent configuration currently says. */
export interface ProviderConfigSnapshot {
  readonly file: string;
  readonly exists: boolean;
  /** Base URL currently configured, if any. */
  readonly baseUrl?: string;
  /** Auth env var currently set, if any. Never the value. */
  readonly authEnvVar?: string;
  /** True when an auth value is present (presence only — never the secret). */
  readonly hasAuth: boolean;
  /** Keys in the provider's `env` block that RouterFlip does not manage. */
  readonly otherEnvKeys: readonly string[];
  /** Top-level keys RouterFlip leaves untouched. Proof of preservation. */
  readonly preservedKeys: readonly string[];
}

export interface ApplyResult {
  readonly targetFile: string;
  /** Dotted paths RouterFlip owns, e.g. `env.ANTHROPIC_BASE_URL`. */
  readonly managedKeys: readonly string[];
  /** 'yes' / 'no' per managed path: did it exist before RouterFlip? */
  readonly preexisting: Record<string, string>;
  /** Backup taken immediately before this write, when a file already existed. */
  readonly backup?: string;
  /** Backup of the very first pre-RouterFlip state, carried forward. */
  readonly originBackup?: string;
  /** Keys that were present before and are still present after. */
  readonly preservedKeys: readonly string[];
  readonly strategy: PermanentStrategy;
}

export interface ClearResult {
  readonly targetFile: string;
  readonly restoredFrom?: string;
  readonly removedKeys: readonly string[];
  readonly changed: boolean;
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  /** Executable names to try, in order. */
  readonly commands: readonly string[];
  /** Documentation of the persistence mechanism, shown by `doctor`. */
  readonly mechanism: string;

  detect(): Promise<ProviderDetection>;

  /**
   * Environment for a child process. Used by temporary mode; must not read or
   * write any configuration file.
   */
  envFor(router: Router, apiKey: string): EnvDelta;

  /**
   * Variables that must be removed from the child environment because they
   * would otherwise compete with `envFor` (e.g. the auth variable this router
   * does not use).
   */
  conflicts(router: Router): readonly string[];

  /** Env var names this provider sets for a given router. */
  envKeys(router: Router): readonly string[];

  configFile(): string;
  inspect(): ProviderConfigSnapshot;

  /** Persists the router choice, preserving every unrelated setting. */
  applyPermanent(router: Router, apiKey: string, options: ApplyOptions): ApplyResult;

  /** Undoes a previous `applyPermanent`, restoring pre-RouterFlip values. */
  clearPermanent(activation: Activation, options: { backupsDir: string }): ClearResult;

  /**
   * The command this provider can call to fetch the key at request time, when it
   * supports one *and* RouterFlip is reachable on PATH — which is what lets the
   * secret stay in the OS credential store. `undefined` means the key would have
   * to be written into the config file instead. Optional: a provider with no
   * helper mechanism simply omits it.
   *
   * `account` names which of the router's credentials to fetch; omitted, the
   * router's selected account is used at call time.
   */
  helperCommand?(router: Router, account?: Account): string | undefined;
}
