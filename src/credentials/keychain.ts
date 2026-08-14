/**
 * macOS backend — the login keychain via the built-in `security` tool.
 *
 * Two write strategies are attempted, in order:
 *   1. stdin: `security add-generic-password -w` with no value reads the secret
 *      from the prompt, which is stdin when not a TTY. Nothing sensitive touches
 *      argv.
 *   2. argv: the widely-used `-w <secret>` form, as a fallback.
 *
 * Every write is verified by reading the value back, so if strategy 1 is not
 * supported by the local `security` build we notice immediately and fall back
 * rather than silently storing nothing.
 */
import { run } from '../util/exec.ts';
import { assertValidRef, SERVICE_NAME, type CredentialStore } from './types.ts';

const SECURITY = '/usr/bin/security';

async function readSecret(ref: string): Promise<string | undefined> {
  const result = await run(SECURITY, ['find-generic-password', '-s', SERVICE_NAME, '-a', ref, '-w']);
  if (result.spawnError || result.code !== 0) return undefined;
  const value = result.stdout.replace(/\r?\n$/, '');
  return value.length > 0 ? value : undefined;
}

async function deleteSecret(ref: string): Promise<void> {
  await run(SECURITY, ['delete-generic-password', '-s', SERVICE_NAME, '-a', ref]);
}

export function createKeychainStore(): CredentialStore {
  return {
    id: 'keychain',
    label: 'macOS Keychain',
    secure: true,
    location: `login keychain, service "${SERVICE_NAME}"`,

    async isAvailable() {
      if (process.platform !== 'darwin') return false;
      const result = await run(SECURITY, ['list-keychains'], { timeoutMs: 5_000 });
      return !result.spawnError && result.code === 0;
    },

    async get(ref) {
      assertValidRef(ref);
      return readSecret(ref);
    },

    async set(ref, secret) {
      assertValidRef(ref);
      // `-U` updates in place when the item already exists.
      const base = ['add-generic-password', '-U', '-s', SERVICE_NAME, '-a', ref, '-D', 'RouterFlip API key', '-j', 'Managed by RouterFlip'];

      // Strategy 1 — secret over stdin (asked for twice by the prompt).
      const viaStdin = await run(SECURITY, [...base, '-w'], { input: `${secret}\n${secret}\n` });
      if (!viaStdin.spawnError && (await readSecret(ref)) === secret) return;

      // Strategy 2 — secret on argv.
      const viaArgv = await run(SECURITY, [...base, '-w', secret]);
      if (!viaArgv.spawnError && (await readSecret(ref)) === secret) return;

      const detail = (viaArgv.stderr || viaStdin.stderr || '').trim().split('\n')[0] ?? 'unknown error';
      throw new Error(`macOS Keychain rejected the write: ${detail}`);
    },

    async remove(ref) {
      assertValidRef(ref);
      await deleteSecret(ref);
    },
  };
}
