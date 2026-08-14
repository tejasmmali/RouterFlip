/**
 * Credential storage (spec §11, §12, §23 and §25: "secure key storage").
 *
 * These tests exercise the portable fallback backend, because that is the one
 * that must be provably safe on machines with no OS keyring — and the only one a
 * test can drive without prompting a real keychain. The OS backends share this
 * exact contract; what is pinned here is the contract plus the two properties the
 * fallback has to earn on its own: the secret is ciphertext at rest, and tampering
 * is detected instead of silently returning nonsense.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { Credentials, resolveBackend } from '../src/credentials/index.ts';
import { createFileStore } from '../src/credentials/file.ts';
import { paths } from '../src/core/paths.ts';
import { existsSync, fileMode } from '../src/core/fsx.ts';
import { RouterFlipError } from '../src/errors.ts';
import { withSandbox, TEST_KEY } from './helpers.ts';

const REF = 'routerflip-alpha';
const OTHER = 'routerflip-beta';
const IS_WINDOWS = process.platform === 'win32';

test('a stored key round-trips, and an unknown ref is simply absent', async () => {
  await withSandbox(async () => {
    const store = createFileStore();
    assert.equal(await store.get(REF), undefined, 'a ref with nothing stored is not an error');
    await store.set(REF, TEST_KEY);
    assert.equal(await store.get(REF), TEST_KEY);
  });
});

test('the vault holds ciphertext and the key that unlocks it lives elsewhere', async () => {
  await withSandbox(async () => {
    await createFileStore().set(REF, TEST_KEY);
    const vault = readFileSync(paths().credentialsFile, 'utf8');

    assert.equal(vault.includes(TEST_KEY), false, 'a plaintext key in the vault would defeat the point');
    assert.equal(vault.includes('sk-test'), false, 'not even a recognisable prefix survives');
    const parsed = JSON.parse(vault) as { algorithm: string; entries: Record<string, { iv: string; tag: string }> };
    assert.equal(parsed.algorithm, 'aes-256-gcm');
    assert.ok(parsed.entries[REF]?.tag, 'an authentication tag is stored, so edits can be detected');
    assert.notEqual(paths().keyFile, paths().credentialsFile, 'copying the vault alone must not be enough');
    assert.equal(existsSync(paths().keyFile), true);
  });
});

test('the same secret under two refs encrypts to unrelated bytes', async () => {
  await withSandbox(async () => {
    const store = createFileStore();
    await store.set(REF, TEST_KEY);
    await store.set(OTHER, TEST_KEY);
    const entries = (JSON.parse(readFileSync(paths().credentialsFile, 'utf8')) as {
      entries: Record<string, { data: string }>;
    }).entries;

    assert.notEqual(entries[REF]?.data, entries[OTHER]?.data, 'a per-ref subkey means no ciphertext reuse');
    assert.equal(await store.get(REF), TEST_KEY);
    assert.equal(await store.get(OTHER), TEST_KEY);
  });
});

test('an edited vault entry is refused rather than half-decrypted', async () => {
  await withSandbox(async () => {
    const store = createFileStore();
    await store.set(REF, TEST_KEY);
    const vault = JSON.parse(readFileSync(paths().credentialsFile, 'utf8')) as {
      entries: Record<string, { data: string }>;
    };
    const entry = vault.entries[REF];
    assert.ok(entry);
    // Flip the ciphertext without touching the tag: GCM must notice.
    vault.entries[REF] = { ...entry, data: Buffer.from('tampered-by-hand').toString('base64') };
    writeFileSync(paths().credentialsFile, JSON.stringify(vault), 'utf8');

    await assert.rejects(store.get(REF), /could not be decrypted/);
  });
});

test('a vault without its key file fails loudly instead of returning nothing', async () => {
  await withSandbox(async () => {
    const store = createFileStore();
    await store.set(REF, TEST_KEY);
    rmSync(paths().keyFile, { force: true });
    // "No key stored" and "cannot decrypt" must not look the same to the caller.
    await assert.rejects(store.get(REF), /cannot be decrypted/);
  });
});

test('removing a ref leaves the others intact', async () => {
  await withSandbox(async () => {
    const store = createFileStore();
    await store.set(REF, TEST_KEY);
    await store.set(OTHER, 'sk-other-0123456789');
    await store.remove(REF);
    await store.remove(REF); // removing twice is not an error

    assert.equal(await store.get(REF), undefined);
    assert.equal(await store.get(OTHER), 'sk-other-0123456789');
  });
});

test('a credential reference is never allowed to be a path', async () => {
  await withSandbox(async () => {
    const store = createFileStore();
    // Refs become OS credential keys and file keys; anything path-like is refused.
    await assert.rejects(store.set('../../etc/passwd', TEST_KEY), /Invalid credential reference/);
    await assert.rejects(store.get('routerflip alpha'), /Invalid credential reference/);
    await assert.rejects(store.set('', TEST_KEY), /Invalid credential reference/);
  });
});

test('the facade turns a backend failure into a RouterFlip error with no secret in it', async () => {
  await withSandbox(async () => {
    const credentials = new Credentials('file');
    await credentials.set(REF, TEST_KEY);
    rmSync(paths().keyFile, { force: true });

    await assert.rejects(
      new Credentials('file').get(REF), // a fresh facade, so nothing is served from cache
      (error: unknown) => {
        assert.ok(error instanceof RouterFlipError);
        assert.equal(error.code, 'CREDENTIAL_READ_FAILED');
        assert.equal(`${error.message} ${error.hint ?? ''}`.includes(TEST_KEY), false);
        return true;
      },
    );
  });
});

test('requiring a missing key names the router and the fix', async () => {
  await withSandbox(async () => {
    const credentials = new Credentials('file');
    await assert.rejects(
      credentials.require('routerflip-alpha', 'Alpha'),
      (error: unknown) => {
        assert.ok(error instanceof RouterFlipError);
        assert.equal(error.code, 'CREDENTIAL_MISSING');
        assert.match(error.message, /No API key is stored for "Alpha"/);
        assert.match(error.hint ?? '', /routerflip edit Alpha/);
        return true;
      },
    );
  });
});

test('presence answers for many refs at once without exposing values', async () => {
  await withSandbox(async () => {
    const credentials = new Credentials('file');
    await credentials.set(REF, TEST_KEY);
    const presence = await credentials.presence([REF, OTHER]);
    assert.deepEqual([...presence.entries()], [[REF, true], [OTHER, false]]);
  });
});

test('an explicitly configured backend that is unavailable is refused, not silently swapped', async () => {
  await withSandbox(async () => {
    // Pick a backend this platform cannot provide.
    const impossible = process.platform === 'darwin' ? 'secret-service' : 'keychain';
    await assert.rejects(
      resolveBackend(impossible),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'CREDENTIAL_STORE_UNAVAILABLE',
    );
  });
});

test('automatic resolution always lands on a usable backend', async () => {
  await withSandbox(async () => {
    const resolved = await resolveBackend('auto');
    assert.equal(['dpapi', 'keychain', 'secret-service', 'file'].includes(resolved.store.id), true);
    assert.equal(await resolved.store.isAvailable(), true);
    assert.equal(resolved.store.label.length > 0, true, 'doctor prints this label');
    if (resolved.store.id === 'file') {
      assert.equal(resolved.store.secure, false, 'the fallback must not claim OS-level protection');
    }
  });
});

test('the vault and key file are readable only by their owner on POSIX', async (t) => {
  if (IS_WINDOWS) {
    t.skip('Windows relies on the inherited user-profile ACL; there is no mode to assert');
    return;
  }
  await withSandbox(async () => {
    await createFileStore().set(REF, TEST_KEY);
    assert.equal(fileMode(paths().credentialsFile), '600');
    assert.equal(fileMode(paths().keyFile), '600');
  });
});
