/**
 * Persisted data shapes.
 *
 * Two files, two responsibilities:
 *
 *   config.json — user-authored router profiles. Non-secret metadata only.
 *                 API keys live in the OS credential store and are referenced
 *                 here by `credentialRef`.
 *   state.json  — machine state: which router is active, and exactly what
 *                 RouterFlip changed in the provider's own config so it can be
 *                 undone. Contains no secrets and no secret values.
 */
import * as v from './validate.ts';

/**
 * 1 → 2 introduced `routers[].accounts`. Version 1 files carry a single key on
 * the router itself and are migrated on load (see `core/migrate.ts`); the bump is
 * what makes that migration run exactly once.
 */
export const CONFIG_VERSION = 2;
/** Config versions below this still keep their credential on the router. */
export const ACCOUNTS_VERSION = 2;
export const STATE_VERSION = 1;

/** Env var a gateway expects the key in. Both are honoured by Claude Code. */
export const AUTH_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;
export type AuthEnvVar = (typeof AUTH_ENV_VARS)[number];
export const DEFAULT_AUTH_ENV_VAR: AuthEnvVar = 'ANTHROPIC_API_KEY';

export const PROVIDER_IDS = ['claude-code'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const DEFAULT_PROVIDER: ProviderId = 'claude-code';

export const CREDENTIAL_BACKENDS = ['auto', 'keychain', 'secret-service', 'dpapi', 'file'] as const;
export type CredentialBackendChoice = (typeof CREDENTIAL_BACKENDS)[number];

export const COLOR_MODES = ['auto', 'always', 'never'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

/** Router names must be printable single-line text (no control characters). */
export function routerNameProblem(name: string): string | undefined {
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return 'Router name must not contain control characters.';
  }
  return undefined;
}

/** Same rule as router names, reported against the field the user was editing. */
export function accountNameProblem(name: string): string | undefined {
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return 'Account name must not contain control characters.';
  }
  return undefined;
}

/**
 * Model ids are passed to the provider verbatim, so they must be a single
 * printable token — a stray newline would corrupt the settings file or the child
 * environment rather than fail loudly.
 */
export function modelNameProblem(name: string): string | undefined {
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return 'A model name must not contain control characters.';
  }
  return undefined;
}

/**
 * One credential belonging to a router.
 *
 * An account is deliberately *not* a place to put a base URL: the router owns the
 * endpoint and the account owns only the key that authenticates against it. As
 * everywhere else in config.json the key itself is absent — `credentialRef` names
 * an entry in the OS credential store.
 */
export const accountSchema = v.object({
  id: v.string({ min: 1, max: 64, label: 'Account id' }),
  name: v.string({
    min: 1,
    max: 48,
    label: 'Account name',
    check: accountNameProblem,
  }),
  credentialRef: v.string({ min: 1, label: 'Credential reference' }),
  description: v.string({ max: 200 }).withDefault(''),
  /**
   * Model this account last launched with, chosen from its router's list.
   *
   * Optional on purpose: model selection is never compulsory, so an account that
   * has never picked one simply has no field here and Claude Code keeps using its
   * own default. The *definitions* live on the router — only the last selection is
   * per-account.
   */
  model: v.string({ min: 1, max: 100, label: 'Model', check: modelNameProblem }).optional(),
  createdAt: v.string({ min: 1 }),
  updatedAt: v.string({ min: 1 }),
});

export type Account = v.Infer<typeof accountSchema>;

export const routerSchema = v.object({
  id: v.string({ min: 1, max: 64, label: 'Router id' }),
  name: v.string({
    min: 1,
    max: 48,
    label: 'Router name',
    check: routerNameProblem,
  }),
  baseUrl: v.string({ min: 1, label: 'Base URL' }),
  /**
   * The router's own credential-store entry.
   *
   * Still required, and still the ref the *first* account uses, which is what lets
   * a version 1 config gain accounts without a single key being moved or
   * re-entered. It also keeps a router that somehow has no accounts usable.
   */
  credentialRef: v.string({ min: 1, label: 'Credential reference' }),
  /** Credentials for this router. One per account; the router owns the URL. */
  accounts: v.array(accountSchema).withDefault(() => []),
  /** Account selected for this router. Cleared when that account is deleted. */
  activeAccount: v.string({ min: 1 }).optional(),
  /**
   * Models this gateway offers, shared by every one of its accounts.
   *
   * The list belongs to the router because it is a property of the endpoint, not
   * of a credential; which one an account last used is remembered on the account.
   * Defaulted rather than required, so every config written before models existed
   * still loads unchanged.
   */
  models: v.array(v.string({ min: 1, max: 100, label: 'Model', check: modelNameProblem })).withDefault(() => []),
  description: v.string({ max: 200 }).withDefault(''),
  provider: v.literalUnion(PROVIDER_IDS).withDefault(DEFAULT_PROVIDER),
  authEnvVar: v.literalUnion(AUTH_ENV_VARS).withDefault(DEFAULT_AUTH_ENV_VAR),
  /** Optional override for the health-check path used by `routerflip test`. */
  testPath: v.string({ max: 200 }).optional(),
  /** Free-form, non-secret metadata (e.g. default model). Never credentials. */
  metadata: v.record(v.string({ max: 200 })).withDefault(() => ({})),
  createdAt: v.string({ min: 1 }),
  updatedAt: v.string({ min: 1 }),
});

export type Router = v.Infer<typeof routerSchema>;

export const configSchema = v.object({
  version: v.integer({ min: 1, max: 100 }).withDefault(CONFIG_VERSION),
  routers: v.array(routerSchema).withDefault(() => []),
  activeRouter: v.string({ min: 1 }).optional(),
  settings: v
    .object({
      credentialBackend: v.literalUnion(CREDENTIAL_BACKENDS).withDefault('auto'),
      color: v.literalUnion(COLOR_MODES).withDefault('auto'),
      /** Default health-check path when a router does not override it. */
      testPath: v.string({ min: 1, max: 200 }).withDefault('/v1/messages'),
      /** Keep at most this many provider-config backups. */
      backupRetention: v.integer({ min: 1, max: 500 }).withDefault(20),
    })
    .withDefault(() => ({
      credentialBackend: 'auto' as CredentialBackendChoice,
      color: 'auto' as ColorMode,
      testPath: '/v1/messages',
      backupRetention: 20,
    })),
});

export type Config = v.Infer<typeof configSchema>;
export type Settings = Config['settings'];

/**
 * Record of a permanent activation. `preexisting` remembers whether each
 * managed key was already present *before* RouterFlip first touched the
 * provider config, so deactivation can put things back. Values are never
 * stored here — restoration reads them from `originBackup`.
 */
export const activationSchema = v.object({
  routerId: v.string({ min: 1 }),
  routerName: v.string({ min: 1 }),
  /** Account whose key was applied. Absent on records written before accounts. */
  accountId: v.string({ min: 1 }).optional(),
  accountName: v.string({ min: 1 }).optional(),
  /** Model written into the provider config, when one was selected. */
  model: v.string({ min: 1, max: 100 }).optional(),
  provider: v.literalUnion(PROVIDER_IDS).withDefault(DEFAULT_PROVIDER),
  appliedAt: v.string({ min: 1 }),
  targetFile: v.string({ min: 1 }),
  managedKeys: v.array(v.string({ min: 1 })).withDefault(() => []),
  preexisting: v.record(v.string({ max: 8 })).withDefault(() => ({})),
  originBackup: v.string({ min: 1 }).optional(),
  lastBackup: v.string({ min: 1 }).optional(),
});

export type Activation = v.Infer<typeof activationSchema>;

export const stateSchema = v.object({
  version: v.integer({ min: 1, max: 100 }).withDefault(STATE_VERSION),
  activation: activationSchema.optional(),
  /** Backend that actually served credentials last run — diagnostics only. */
  credentialBackend: v.literalUnion(['keychain', 'secret-service', 'dpapi', 'file']).optional(),
  lastUsedRouterId: v.string({ min: 1 }).optional(),
  lastTemporaryRouterId: v.string({ min: 1 }).optional(),
  lastTemporaryAccountId: v.string({ min: 1 }).optional(),
  lastTemporaryAt: v.string({ min: 1 }).optional(),
});

export type State = v.Infer<typeof stateSchema>;

export function emptyConfig(): Config {
  const parsed = configSchema.safeParse({});
  if (!parsed.ok) throw new Error('internal: default config failed validation');
  return parsed.value;
}

export function emptyState(): State {
  const parsed = stateSchema.safeParse({});
  if (!parsed.ok) throw new Error('internal: default state failed validation');
  return parsed.value;
}
