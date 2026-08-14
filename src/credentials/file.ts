/**
 * Portable fallback backend — AES-256-GCM in a 0600 file.
 *
 * Used only when no OS credential service is available (headless Linux, CI,
 * containers, or an explicit `credentialBackend: "file"`).
 *
 * What this protects against, honestly:
 *   ✓ A stray `cat config.json`, a screenshot, or a directory listing.
 *   ✓ Copying the config folder to another machine or into a git repo — the
 *     ciphertext is useless without `credentials.key`.
 *   ✓ Cloud-sync folders picking up plaintext keys.
 *
 * What it does NOT protect against:
 *   ✗ Anything running as your user on this machine. It can read the key file.
 *     No local-only scheme can prevent that; the OS keychains defend this case
 *     by requiring user consent, which is why they are preferred.
 */
import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { existsSync, readTextIfExists, restrictFile, writeJsonAtomic, writeTextAtomic } from '../core/fsx.ts';
import { paths } from '../core/paths.ts';
import { assertValidRef, type CredentialStore } from './types.ts';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

interface Entry {
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}
interface Vault {
  version: number;
  algorithm: string;
  entries: Record<string, Entry>;
}

function emptyVault(): Vault {
  return { version: 1, algorithm: ALGORITHM, entries: {} };
}

function loadMasterKey(keyFile: string): Buffer {
  const existing = readTextIfExists(keyFile);
  if (existing) {
    const key = Buffer.from(existing.trim(), 'base64');
    if (key.length === KEY_BYTES) return key;
  }
  const key = randomBytes(KEY_BYTES);
  writeTextAtomic(keyFile, `${key.toString('base64')}\n`);
  restrictFile(keyFile);
  return key;
}

/** Per-ref subkey so the same plaintext under two refs yields unrelated bytes. */
function deriveKey(master: Buffer, ref: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.from('routerflip-vault-v1'), Buffer.from(ref, 'utf8'), KEY_BYTES));
}

function loadVault(file: string): Vault {
  const raw = readTextIfExists(file);
  if (!raw) return emptyVault();
  try {
    const parsed = JSON.parse(raw) as Partial<Vault>;
    return {
      version: parsed.version ?? 1,
      algorithm: parsed.algorithm ?? ALGORITHM,
      entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
    };
  } catch {
    return emptyVault();
  }
}

export function createFileStore(): CredentialStore {
  const { credentialsFile, keyFile } = paths();

  return {
    id: 'file',
    label: 'Encrypted file (AES-256-GCM)',
    secure: false,
    location: credentialsFile,

    async isAvailable() {
      return true; // The last-resort backend is always available.
    },

    async get(ref) {
      assertValidRef(ref);
      const vault = loadVault(credentialsFile);
      const entry = vault.entries[ref];
      if (!entry) return undefined;
      if (!existsSync(keyFile)) {
        throw new Error('The credential key file is missing, so stored keys cannot be decrypted.');
      }
      try {
        const key = deriveKey(loadMasterKey(keyFile), ref);
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(entry.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
        const plain = Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]);
        return plain.toString('utf8');
      } catch {
        throw new Error('A stored key could not be decrypted (wrong key file, or the file was edited).');
      }
    },

    async set(ref, secret) {
      assertValidRef(ref);
      const key = deriveKey(loadMasterKey(keyFile), ref);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const data = Buffer.concat([cipher.update(Buffer.from(secret, 'utf8')), cipher.final()]);
      const vault = loadVault(credentialsFile);
      vault.entries[ref] = {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      };
      writeJsonAtomic(credentialsFile, vault);
      restrictFile(credentialsFile);
    },

    async remove(ref) {
      assertValidRef(ref);
      const vault = loadVault(credentialsFile);
      if (!(ref in vault.entries)) return;
      delete vault.entries[ref];
      writeJsonAtomic(credentialsFile, vault);
    },
  };
}
