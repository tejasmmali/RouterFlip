/**
 * Permanent mode: persist a router choice into the provider's own configuration.
 *
 * The safety rules from spec §6 live here rather than in the command layer, so
 * every entry point (dashboard, `use --permanent`) gets them:
 *
 *   - a timestamped backup is taken before the first byte is written;
 *   - only the keys RouterFlip declares as managed are touched;
 *   - what existed *before* RouterFlip is recorded once, so `deactivate` can put
 *     the file back without RouterFlip ever storing a secret value itself.
 */
import { paths } from '../core/paths.ts';
import { loadState, saveState } from '../core/store.ts';
import type { Account, Activation, Router } from '../core/schema.ts';
import { logger } from '../logger.ts';
import { activationFrom } from '../providers/claude-code.ts';
import type { ApplyResult, ClearResult, PermanentStrategy, Provider } from '../providers/types.ts';

export interface ApplyPermanentInput {
  readonly router: Router;
  readonly apiKey: string;
  readonly provider: Provider;
  readonly strategy?: PermanentStrategy;
  readonly backupRetention?: number;
  /** The account `apiKey` came from, so the record names it and the helper fetches it. */
  readonly account?: Account;
}

export interface ApplyPermanentOutcome {
  readonly result: ApplyResult;
  readonly activation: Activation;
  /** True when 'helper' was explicitly requested but unavailable, so 'env' was used. */
  readonly strategyDowngraded: boolean;
}

export function currentActivation(): Activation | undefined {
  return loadState().activation;
}

export function applyPermanent(input: ApplyPermanentInput): ApplyPermanentOutcome {
  const { backupsDir } = paths();
  const previous = currentActivation();
  // Default to the credential-helper strategy so the key stays in the OS store
  // (spec §23). The provider falls back to writing it into settings.json when
  // `routerflip` is not on PATH, since a helper it cannot run would be worse.
  const requested = input.strategy ?? 'helper';

  const result = input.provider.applyPermanent(input.router, input.apiKey, {
    backupsDir,
    strategy: requested,
    ...(input.backupRetention === undefined ? {} : { backupRetention: input.backupRetention }),
    ...(input.account ? { account: input.account } : {}),
    ...(previous && previous.provider === input.router.provider ? { previous } : {}),
  });

  const activation = activationFrom(input.router, result, input.account);
  const state = loadState();
  saveState({ ...state, activation, lastUsedRouterId: input.router.id });
  logger.debug(`permanent activation recorded for ${input.router.id}`);

  return {
    result,
    activation,
    // Only a downgrade if the user asked for it by name; the default choosing
    // 'env' on its own is a fallback, not a thwarted instruction.
    strategyDowngraded: input.strategy !== undefined && input.strategy !== result.strategy,
  };
}

export interface ClearPermanentOutcome {
  readonly result: ClearResult;
  readonly activation: Activation;
}

/** Reverts the provider config and forgets the activation record. */
export function clearPermanent(provider: Provider): ClearPermanentOutcome | undefined {
  const activation = currentActivation();
  if (!activation) return undefined;
  const { backupsDir } = paths();
  const result = provider.clearPermanent(activation, { backupsDir });
  const state = loadState();
  saveState({ ...state, activation: undefined });
  logger.debug('permanent activation cleared');
  return { result, activation };
}
