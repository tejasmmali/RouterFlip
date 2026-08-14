/**
 * Linux backend — the Secret Service API (GNOME Keyring, KWallet via
 * kwalletmanager's Secret Service bridge, KeePassXC, …) through `secret-tool`.
 *
 * `secret-tool store` reads the secret from stdin, so nothing sensitive is ever
 * placed on the command line.
 *
 * Requires a running Secret Service provider on the session D-Bus. Headless
 * servers and containers usually have none, which is exactly when RouterFlip
 * falls back to the encrypted file store.
 */
import { run } from '../util/exec.ts';
import { assertValidRef, SERVICE_NAME, type CredentialStore } from './types.ts';

const TOOL = 'secret-tool';

function attrs(ref: string): string[] {
  return ['service', SERVICE_NAME, 'account', ref];
}

export function createSecretServiceStore(): CredentialStore {
  return {
    id: 'secret-service',
    label: 'Secret Service (libsecret)',
    secure: true,
    location: `session keyring, service "${SERVICE_NAME}"`,

    async isAvailable() {
      if (process.platform === 'win32' || process.platform === 'darwin') return false;
      const help = await run(TOOL, ['--help'], { timeoutMs: 5_000 });
      if (help.spawnError) return false;
      // `secret-tool` exists, but without a session bus / unlocked collection any
      // real operation fails. A lookup for a key we know is absent distinguishes
      // "no service" (non-zero + stderr) from "service present, key missing"
      // (exit 1, empty stderr).
      const probeResult = await run(TOOL, ['lookup', 'service', SERVICE_NAME, 'account', '__routerflip_probe__'], {
        timeoutMs: 5_000,
      });
      if (probeResult.spawnError) return false;
      const stderr = probeResult.stderr.toLowerCase();
      if (stderr.includes('cannot autolaunch') || stderr.includes('dbus') || stderr.includes('was not provided by any .service')) {
        return false;
      }
      return true;
    },

    async get(ref) {
      assertValidRef(ref);
      const result = await run(TOOL, ['lookup', ...attrs(ref)]);
      if (result.spawnError || result.code !== 0) return undefined;
      const value = result.stdout.replace(/\r?\n$/, '');
      return value.length > 0 ? value : undefined;
    },

    async set(ref, secret) {
      assertValidRef(ref);
      const result = await run(TOOL, ['store', '--label', `${SERVICE_NAME}: ${ref}`, ...attrs(ref)], {
        input: secret,
      });
      if (result.spawnError) throw new Error('secret-tool is not installed.');
      if (result.code !== 0) {
        const detail = result.stderr.trim().split('\n')[0] ?? `exit code ${result.code}`;
        throw new Error(`Secret Service rejected the write: ${detail}`);
      }
    },

    async remove(ref) {
      assertValidRef(ref);
      await run(TOOL, ['clear', ...attrs(ref)]);
    },
  };
}
