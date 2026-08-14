/**
 * Permanent mode (spec §6, §26, §29c and §25: "permanent configuration logic").
 *
 * The claims proven here are the ones a user has to trust before letting a tool
 * edit their Claude Code settings:
 *   - unrelated settings survive byte-for-byte;
 *   - a backup exists before the first byte is written;
 *   - deactivating restores what was there before RouterFlip, including values
 *     RouterFlip never stored anywhere (they come back from the backup);
 *   - a settings file RouterFlip cannot parse is refused, not overwritten.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { claudeCode, activationFrom } from '../src/providers/claude-code.ts';
import { paths } from '../src/core/paths.ts';
import { RouterFlipError } from '../src/errors.ts';
import type { ApplyResult } from '../src/providers/types.ts';
import { makeRouter, withSandbox, TEST_KEY, type Sandbox } from './helpers.ts';

/** A settings.json with several keys RouterFlip has no business touching. */
const EXISTING_SETTINGS = {
  model: 'opusplan',
  permissions: { allow: ['Bash(git:*)'] },
  includeCoAuthoredBy: false,
  env: { MY_OWN_VAR: 'keep-me', ANTHROPIC_BASE_URL: 'https://old.example' },
};

function writeSettings(sandbox: Sandbox, value: unknown): void {
  mkdirSync(sandbox.claudeDir, { recursive: true });
  writeFileSync(sandbox.settingsFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readSettings(sandbox: Sandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(sandbox.settingsFile, 'utf8')) as Record<string, unknown>;
}

function apply(previous?: ApplyResult): ApplyResult {
  const router = makeRouter({ baseUrl: 'https://api.alpha.example' });
  return claudeCode.applyPermanent(router, TEST_KEY, {
    backupsDir: paths().backupsDir,
    strategy: 'env',
    ...(previous ? { previous: activationFrom(router, previous) } : {}),
  });
}

test('applying preserves every unrelated setting', async () => {
  await withSandbox(async (sandbox) => {
    writeSettings(sandbox, EXISTING_SETTINGS);
    const result = apply();
    const after = readSettings(sandbox);

    assert.equal(after.model, 'opusplan');
    assert.deepEqual(after.permissions, { allow: ['Bash(git:*)'] });
    assert.equal(after.includeCoAuthoredBy, false);
    const env = after.env as Record<string, unknown>;
    assert.equal(env.MY_OWN_VAR, 'keep-me', 'an unrelated env var must survive');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.alpha.example');
    assert.equal(env.ANTHROPIC_API_KEY, TEST_KEY);
    assert.deepEqual([...result.preservedKeys].sort(), ['includeCoAuthoredBy', 'model', 'permissions']);
    assert.deepEqual(result.managedKeys, ['env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_API_KEY']);
  });
});

test('a backup is written before the file is modified', async () => {
  await withSandbox(async (sandbox) => {
    writeSettings(sandbox, EXISTING_SETTINGS);
    const result = apply();

    assert.ok(result.backup, 'a pre-write backup path must be reported');
    const backup = JSON.parse(readFileSync(result.backup, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(backup, EXISTING_SETTINGS, 'the backup is the file as it was before');
  });
});

test('a first apply records what predated RouterFlip', async () => {
  await withSandbox(async (sandbox) => {
    writeSettings(sandbox, EXISTING_SETTINGS);
    const result = apply();
    assert.equal(result.preexisting['env.ANTHROPIC_BASE_URL'], 'yes');
    assert.equal(result.preexisting['env.ANTHROPIC_API_KEY'], 'no');
  });
});

test('re-applying does not relabel our own keys as pre-existing', async () => {
  await withSandbox(async (sandbox) => {
    writeSettings(sandbox, EXISTING_SETTINGS);
    const first = apply();
    const second = apply(first);
    assert.deepEqual(second.preexisting, first.preexisting, 'the original answer is carried forward');
    assert.ok(second.backup, 'every apply backs the file up again');
    assert.equal(
      second.originBackup,
      first.originBackup,
      'the earliest backup stays the restore source, so the pre-RouterFlip value is still recoverable',
    );
  });
});

test('applying to a machine with no settings file creates one', async () => {
  await withSandbox(async (sandbox) => {
    const result = apply();
    assert.equal(result.backup, undefined, 'nothing existed, so nothing was backed up');
    assert.deepEqual(result.preservedKeys, []);
    const after = readSettings(sandbox);
    assert.deepEqual(Object.keys(after), ['env']);
    assert.equal((after.env as Record<string, unknown>).ANTHROPIC_BASE_URL, 'https://api.alpha.example');
  });
});

test('deactivating restores the previous value and removes what we added', async () => {
  await withSandbox(async (sandbox) => {
    writeSettings(sandbox, EXISTING_SETTINGS);
    const router = makeRouter();
    const result = apply();
    const cleared = claudeCode.clearPermanent(activationFrom(router, result), { backupsDir: paths().backupsDir });

    assert.equal(cleared.changed, true);
    assert.deepEqual(cleared.removedKeys, ['env.ANTHROPIC_API_KEY']);
    const after = readSettings(sandbox);
    const env = after.env as Record<string, unknown>;
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://old.example', 'a pre-existing value comes back');
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'a key we added is removed');
    assert.equal(env.MY_OWN_VAR, 'keep-me');
    assert.equal(after.model, 'opusplan');
    assert.equal(readFileSync(sandbox.settingsFile, 'utf8').includes(TEST_KEY), false, 'no key is left behind');
  });
});

test('deactivating drops an env block that only ever held our keys', async () => {
  await withSandbox(async (sandbox) => {
    const router = makeRouter();
    const result = apply();
    claudeCode.clearPermanent(activationFrom(router, result), { backupsDir: paths().backupsDir });
    const after = readSettings(sandbox);
    assert.equal(after.env, undefined, 'an empty env block is removed rather than left as {}');
  });
});

test('the helper strategy keeps the key out of the settings file', async () => {
  await withSandbox(async (sandbox) => {
    writeSettings(sandbox, EXISTING_SETTINGS);
    const router = makeRouter();
    const result = claudeCode.applyPermanent(router, TEST_KEY, {
      backupsDir: paths().backupsDir,
      strategy: 'helper',
    });

    const raw = readFileSync(sandbox.settingsFile, 'utf8');
    if (result.strategy === 'helper') {
      assert.equal(raw.includes(TEST_KEY), false, 'the secret stays in the OS credential store');
      assert.deepEqual(result.managedKeys, ['env.ANTHROPIC_BASE_URL', 'apiKeyHelper']);
      assert.match(String(readSettings(sandbox).apiKeyHelper), /credential alpha-1$/);
    } else {
      // Documented fallback: no `routerflip` on PATH means no helper is runnable.
      assert.equal(result.strategy, 'env');
      assert.equal(raw.includes(TEST_KEY), true);
    }
    assert.equal((readSettings(sandbox).env as Record<string, unknown>).MY_OWN_VAR, 'keep-me');
  });
});

test('a settings file that is not valid JSON is refused, not repaired', async () => {
  await withSandbox(async (sandbox) => {
    mkdirSync(sandbox.claudeDir, { recursive: true });
    writeFileSync(sandbox.settingsFile, '{ "model": broken', 'utf8');
    assert.throws(
      () => apply(),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'PROVIDER_CONFIG_FAILED',
    );
    assert.equal(readFileSync(sandbox.settingsFile, 'utf8'), '{ "model": broken', 'the file is untouched');
  });
});

test('a settings file written with a UTF-8 BOM is still readable', async () => {
  await withSandbox(async (sandbox) => {
    mkdirSync(sandbox.claudeDir, { recursive: true });
    // PowerShell redirection and several Windows editors add one; JSON.parse rejects it.
    const bom = String.fromCharCode(0xfeff);
    writeFileSync(sandbox.settingsFile, `${bom}${JSON.stringify(EXISTING_SETTINGS)}`, 'utf8');
    const result = apply();
    assert.deepEqual([...result.preservedKeys].sort(), ['includeCoAuthoredBy', 'model', 'permissions']);
  });
});

test('inspect reports presence without ever reading out a secret', async () => {
  await withSandbox(async (sandbox) => {
    assert.equal(claudeCode.inspect().exists, false);
    writeSettings(sandbox, { ...EXISTING_SETTINGS, env: { ...EXISTING_SETTINGS.env, ANTHROPIC_API_KEY: TEST_KEY } });
    const snapshot = claudeCode.inspect();
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.hasAuth, true);
    assert.equal(snapshot.authEnvVar, 'ANTHROPIC_API_KEY');
    assert.equal(snapshot.baseUrl, 'https://old.example');
    assert.deepEqual(snapshot.otherEnvKeys, ['MY_OWN_VAR']);
    assert.equal(JSON.stringify(snapshot).includes(TEST_KEY), false, 'a snapshot is presence-only');
  });
});

test('switching the auth variable does not leave the old one behind', async () => {
  await withSandbox(async (sandbox) => {
    const first = claudeCode.applyPermanent(makeRouter(), TEST_KEY, {
      backupsDir: paths().backupsDir,
      strategy: 'env',
    });
    const tokenRouter = makeRouter({ authEnvVar: 'ANTHROPIC_AUTH_TOKEN' });
    claudeCode.applyPermanent(tokenRouter, 'token-value-0123456789', {
      backupsDir: paths().backupsDir,
      strategy: 'env',
      previous: activationFrom(makeRouter(), first),
    });
    const env = readSettings(sandbox).env as Record<string, unknown>;
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'token-value-0123456789');
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'the key we added under the old name is cleared');
  });
});

test('backups are pruned to the configured retention', async () => {
  await withSandbox(async () => {
    for (let index = 0; index < 4; index += 1) {
      claudeCode.applyPermanent(makeRouter(), TEST_KEY, {
        backupsDir: paths().backupsDir,
        strategy: 'env',
        backupRetention: 2,
      });
    }
    const backups = readdirSync(paths().backupsDir).filter((name) => name.startsWith('claude-settings-'));
    assert.equal(backups.length <= 2, true, `expected at most 2 backups, found ${backups.length}`);
  });
});
