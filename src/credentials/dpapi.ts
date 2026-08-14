/**
 * Windows backend — DPAPI (Data Protection API), user scope.
 *
 * Secrets are encrypted by Windows with a key derived from the current user's
 * logon credentials, so the ciphertext is useless to another account on the same
 * machine and useless if the file is copied elsewhere. This is the same
 * mechanism `ConvertFrom-SecureString` uses, and it needs no native module —
 * which keeps `npm i -g routerflip` a pure-JS install.
 *
 * Plaintext travels over the child process's stdin (base64-wrapped so newlines
 * and code pages cannot corrupt it) and never appears on a command line, in a
 * temp file, or in PowerShell history.
 */
import { readTextIfExists, writeJsonAtomic } from '../core/fsx.ts';
import { paths } from '../core/paths.ts';
import { run } from '../util/exec.ts';
import { assertValidRef, type CredentialStore } from './types.ts';

const POWERSHELL = 'powershell.exe';

const ENCRYPT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$b64 = [Console]::In.ReadToEnd().Trim()
$plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
[Console]::Out.Write((ConvertFrom-SecureString -SecureString $secure))
`;

const DECRYPT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$lines = [Console]::In.ReadToEnd() -split "\`n"
$out = New-Object System.Collections.Generic.List[string]
foreach ($line in $lines) {
  $blob = $line.Trim()
  if ($blob.Length -eq 0) { continue }
  try {
    $secure = ConvertTo-SecureString -String $blob
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    $out.Add([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain)))
  } catch {
    $out.Add('!')
  }
}
[Console]::Out.Write([string]::Join("\`n", $out))
`;

function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function powershell(script: string, input: string): Promise<string> {
  const result = await run(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)],
    { input, timeoutMs: 20_000 },
  );
  if (result.spawnError) throw new Error('Windows PowerShell could not be started.');
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n')[0] ?? `exit code ${result.code}`;
    throw new Error(`Windows credential encryption failed: ${detail}`);
  }
  return result.stdout;
}

type BlobFile = { version: number; blobs: Record<string, string> };

function readBlobs(file: string): BlobFile {
  const raw = readTextIfExists(file);
  if (!raw) return { version: 1, blobs: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<BlobFile>;
    return { version: 1, blobs: parsed.blobs && typeof parsed.blobs === 'object' ? parsed.blobs : {} };
  } catch {
    return { version: 1, blobs: {} };
  }
}

export function createDpapiStore(): CredentialStore {
  const file = paths().credentialsFile.replace(/\.enc\.json$/, '.dpapi.json');

  const store: CredentialStore = {
    id: 'dpapi',
    label: 'Windows DPAPI (user scope)',
    secure: true,
    location: file,

    async isAvailable() {
      if (process.platform !== 'win32') return false;
      try {
        const blob = await powershell(ENCRYPT_SCRIPT, Buffer.from('routerflip-probe', 'utf8').toString('base64'));
        return blob.trim().length > 0;
      } catch {
        return false;
      }
    },

    async get(ref) {
      assertValidRef(ref);
      const found = await store.getMany!([ref]);
      return found.get(ref);
    },

    async getMany(refs) {
      const { blobs } = readBlobs(file);
      const present = refs.filter((ref) => typeof blobs[ref] === 'string');
      const out = new Map<string, string | undefined>(refs.map((ref) => [ref, undefined]));
      if (present.length === 0) return out;
      const stdout = await powershell(DECRYPT_SCRIPT, present.map((ref) => blobs[ref]).join('\n'));
      const lines = stdout.split('\n');
      present.forEach((ref, index) => {
        const line = (lines[index] ?? '').trim();
        if (line.length === 0 || line === '!') return;
        out.set(ref, Buffer.from(line, 'base64').toString('utf8'));
      });
      return out;
    },

    async set(ref, secret) {
      assertValidRef(ref);
      const blob = (await powershell(ENCRYPT_SCRIPT, Buffer.from(secret, 'utf8').toString('base64'))).trim();
      if (blob.length === 0) throw new Error('Windows returned an empty encrypted value.');
      const current = readBlobs(file);
      current.blobs[ref] = blob;
      writeJsonAtomic(file, current);
      // Verify the round trip before reporting success.
      const check = await store.get(ref);
      if (check !== secret) throw new Error('Encrypted value did not decrypt back correctly.');
    },

    async remove(ref) {
      assertValidRef(ref);
      const current = readBlobs(file);
      if (!(ref in current.blobs)) return;
      delete current.blobs[ref];
      writeJsonAtomic(file, current);
    },
  };

  return store;
}
