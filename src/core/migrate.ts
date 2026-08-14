/**
 * Forward migration of config.json.
 *
 * Version 1 gave every router exactly one credential, named by the router's own
 * `credentialRef`. Version 2 moves credentials into `routers[].accounts`. The
 * migration is therefore a pure rewrite of config.json: the first account *keeps*
 * the router's existing ref, so not one key is moved, re-derived or re-entered,
 * and a half-finished run cannot lose a credential.
 *
 * Two properties matter more than the transform itself:
 *
 *   - **It is gated on the version, not on `accounts.length === 0`.** Gating on an
 *     empty list would recreate "Account 1" — pointing at a credential the user
 *     just deleted — every single load, so deleting the last account would be
 *     impossible and the run would not be idempotent.
 *   - **It is pure.** `migrateConfig` decides; the caller persists, and only when
 *     `changed` is true, so reading a config never rewrites it and a machine with
 *     no config.json still has none afterwards.
 */
import { ACCOUNTS_VERSION, CONFIG_VERSION, type Account, type Config, type Router } from './schema.ts';
import { FIRST_ACCOUNT_NAME } from './accounts.ts';
import { uniqueId } from './id.ts';

export interface MigrationOutcome {
  readonly config: Config;
  /** True when `config` differs from the input and should be written back. */
  readonly changed: boolean;
}

/**
 * Wraps a version 1 router's single credential in an account.
 *
 * The account inherits the router's timestamps rather than `now`: the credential
 * is not new, and showing it as created the moment RouterFlip was upgraded would
 * be a lie the user cannot correct.
 */
function withFirstAccount(router: Router): Router {
  const account: Account = {
    id: uniqueId(FIRST_ACCOUNT_NAME, [], 'account'),
    name: FIRST_ACCOUNT_NAME,
    credentialRef: router.credentialRef,
    description: '',
    createdAt: router.createdAt,
    updatedAt: router.updatedAt,
  };
  return { ...router, accounts: [account], activeAccount: account.id };
}

/**
 * Brings `config` up to `CONFIG_VERSION`, reporting whether anything changed.
 *
 * A router that already has accounts is left exactly as it is, even in a version 1
 * file: a hand-written config is the author's, not ours to reshape.
 */
export function migrateConfig(config: Config): MigrationOutcome {
  if (config.version >= ACCOUNTS_VERSION) return { config, changed: false };

  const routers = config.routers.map((router) => (router.accounts.length === 0 ? withFirstAccount(router) : router));
  return { config: { ...config, version: CONFIG_VERSION, routers }, changed: true };
}
