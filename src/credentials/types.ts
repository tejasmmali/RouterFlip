/**
 * Credential store contract.
 *
 * A store maps an opaque `ref` (e.g. `routerflip-agentrouter`) to a secret
 * string. config.json only ever holds the ref. Implementations must not log,
 * echo, or persist the secret anywhere other than their backing store.
 */

export type BackendId = 'keychain' | 'secret-service' | 'dpapi' | 'file';

export interface CredentialStore {
  readonly id: BackendId;
  /** Human label for `doctor` / `status` output. */
  readonly label: string;
  /** True when the OS protects the secret at rest independently of RouterFlip. */
  readonly secure: boolean;
  /** Short note shown in diagnostics (e.g. where the data lives). */
  readonly location: string;
  isAvailable(): Promise<boolean>;
  get(ref: string): Promise<string | undefined>;
  set(ref: string, secret: string): Promise<void>;
  remove(ref: string): Promise<void>;
  /** Optional batch read; falls back to sequential `get` when absent. */
  getMany?(refs: readonly string[]): Promise<Map<string, string | undefined>>;
}

export const SERVICE_NAME = 'RouterFlip';

/** Refs are used as OS credential keys, so keep them boring and predictable. */
export function assertValidRef(ref: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(ref)) {
    throw new Error(`Invalid credential reference: ${JSON.stringify(ref)}`);
  }
}
