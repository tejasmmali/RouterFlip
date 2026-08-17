/**
 * Library entry point.
 *
 * RouterFlip is a CLI first, but the pieces are useful on their own — the tests
 * import from here, and so could a script that wants to launch Claude Code
 * against a stored gateway. Only the stable surface is re-exported: anything not
 * listed here is an internal detail and may change.
 *
 * Note what is deliberately absent: there is no export that returns a raw API
 * key. Keys are read from the credential store at the moment they are handed to
 * a child process or a request, and nowhere else.
 */
export { main } from './cli.ts';
export { parseArgs, Flags, type Parsed, type FlagValue } from './args.ts';
export { createContext, type AppContext } from './context.ts';
export { RouterFlipError, CancelledError, isCancelled, type ErrorCode } from './errors.ts';
export { versionInfo } from './version.ts';

export {
  AUTH_ENV_VARS,
  CREDENTIAL_BACKENDS,
  PROVIDER_IDS,
  type Activation,
  type AuthEnvVar,
  type ColorMode,
  type Config,
  type CredentialBackendChoice,
  type ProviderId,
  type Router,
  type Settings,
  type State,
} from './core/schema.ts';
export { RouterService, type RouterView, type NewRouterInput, type RouterPatch } from './core/routers.ts';
export { loadConfig, loadState, saveConfig, saveState, updateState, isFirstRun } from './core/store.ts';
export { maskSecret, redact } from './core/mask.ts';
export { normalizeUrl, checkUrl } from './core/url.ts';
export { paths, claudeSettingsFile } from './core/paths.ts';

export { Credentials } from './credentials/index.ts';
export { providerFor, allProviders } from './providers/index.ts';
export type { Provider, ApplyResult, ClearResult, PermanentStrategy } from './providers/types.ts';

export { applyPermanent, clearPermanent, currentActivation } from './services/activation.ts';
export { launchRouter, buildChildEnv, type LaunchResult } from './services/launcher.ts';
export { testRouter, endpointFor, type TestReport, type TestStep, type FailureReason } from './services/tester.ts';
export { runDoctor, type DoctorReport, type Check } from './services/doctor.ts';
