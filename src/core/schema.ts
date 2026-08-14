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

export const CONFIG_VERSION = 1;
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

export const routerSchema = v.object({
  id: v.string({ min: 1, max: 64, label: 'Router id' }),
  name: v.string({
    min: 1,
    max: 48,
    label: 'Router name',
    check: routerNameProblem,
  }),
  baseUrl: v.string({ min: 1, label: 'Base URL' }),
  credentialRef: v.string({ min: 1, label: 'Credential reference' }),
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
