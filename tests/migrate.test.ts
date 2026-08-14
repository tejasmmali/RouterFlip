/**
 * Backward compatibility: a version 1 config.json gains accounts on load.
 *
 * The property that matters most is that *no key moves*. A version 1 router keeps
 * one credential under its own `credentialRef`, and the account the migration
 * creates points at that same ref — so an existing install keeps working without
 * anybody re-entering a key, and a half-finished upgrade cannot lose one.
 *
 * The second property is idempotence, tested from both directions: loading twice
 * must not produce two "Account 1"s, and deleting the last account must not be
 * undone by the next load.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Credentials } from '../src/credentials/index.ts';
import { RouterService } from '../src/core/routers.ts';
import { ensureDir } from '../src/core/fsx.ts';
import { migrateConfig } from '../src/core/migrate.ts';
import { paths } from '../src/core/paths.ts';
import { CONFIG_VERSION, configSchema, type Config } from '../src/core/schema.ts';
import { loadConfig } from '../src/core/store.ts';
import { withSandbox, TEST_KEY } from './helpers.ts';

/** The exact shape RouterFlip wrote before accounts existed: no `accounts` key. */
function legacyConfig(): Record<string, unknown> {
  return {
    version: 1,
    activeRouter: 'gorouter',
    routers: [
      {
        id: 'gorouter',
        name: 'GoRouter',
        baseUrl: 'https://api.gorouter.example',
        credentialRef: 'routerflip-gorouter',
        description: 'the one from before',
        provider: 'claude-code',
        authEnvVar: 'ANTHROPIC_API_KEY',
        metadata: {},
        createdAt: '2025-06-01T10:00:00.000Z',
        updatedAt: '2025-06-02T11:00:00.000Z',
      },
    ],
  };
}

/** Writes a legacy config.json and stores its key where version 1 kept it. */
async function seedLegacy(): Promise<void> {
  const { configFile, home } = paths();
  ensureDir(home);
  writeFileSync(configFile, `${JSON.stringify(legacyConfig(), null, 2)}\n`, 'utf8');
  await new Credentials('file').set('routerflip-gorouter', TEST_KEY);
}

/** Parses a raw object the way `loadConfig` does, without touching disk. */
function parse(raw: Record<string, unknown>): Config {
  const result = configSchema.safeParse(raw);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

test('a version 1 router gains one account that keeps its existing credential', () => {
  const outcome = migrateConfig(parse(legacyConfig()));

  assert.equal(outcome.changed, true);
  assert.equal(outcome.config.version, CONFIG_VERSION);

  const router = outcome.config.routers[0];
  assert.ok(router);
  assert.equal(router.accounts.length, 1);

  const account = router.accounts[0];
  assert.ok(account);
  assert.equal(account.name, 'Account 1');
  // The whole point: the same ref, so the stored key is still the one in use.
  assert.equal(account.credentialRef, 'routerflip-gorouter');
  assert.equal(account.credentialRef, router.credentialRef);
  assert.equal(router.activeAccount, account.id);
  // Not created today — the credential predates the upgrade.
  assert.equal(account.createdAt, '2025-06-01T10:00:00.000Z');
  assert.equal(account.updatedAt, '2025-06-02T11:00:00.000Z');
});

test('migration is pure: an up-to-date config is returned untouched', () => {
  const migrated = migrateConfig(parse(legacyConfig())).config;
  const second = migrateConfig(migrated);
  assert.equal(second.changed, false);
  assert.equal(second.config, migrated, 'the same object, so nothing is rewritten');
});

test('a hand-written config that already has accounts is left alone', () => {
  const raw = legacyConfig();
  const routers = raw.routers as Record<string, unknown>[];
  const first = routers[0];
  assert.ok(first);
  first.accounts = [
    {
      id: 'account-mine',
      name: 'Mine',
      credentialRef: 'routerflip-gorouter.account-mine',
      description: '',
      createdAt: '2025-06-01T10:00:00.000Z',
      updatedAt: '2025-06-01T10:00:00.000Z',
    },
  ];

  const router = migrateConfig(parse(raw)).config.routers[0];
  assert.ok(router);
  assert.equal(router.accounts.length, 1);
  assert.equal(router.accounts[0]?.name, 'Mine');
});

test('loading a legacy config migrates it on disk without re-entering the key', async () => {
  await withSandbox(async () => {
    await seedLegacy();

    const config = loadConfig();
    assert.equal(config.version, CONFIG_VERSION);
    const router = config.routers[0];
    assert.ok(router);
    assert.equal(router.accounts.length, 1);

    // The migration was written back, and the key is still readable through the
    // account that now owns it.
    const raw = readFileSync(paths().configFile, 'utf8');
    assert.equal(raw.includes('"version": 2'), true);
    assert.equal(raw.includes(TEST_KEY), false, 'config.json must never contain a key');

    const service = new RouterService(new Credentials('file'));
    const resolved = service.resolve('GoRouter');
    assert.equal(await service.apiKey(resolved), TEST_KEY);
    assert.equal(await service.apiKey(resolved, resolved.accounts[0]), TEST_KEY);
  });
});

test('loading twice does not create a second Account 1', async () => {
  await withSandbox(async () => {
    await seedLegacy();

    const first = loadConfig();
    const firstAccounts = first.routers[0]?.accounts ?? [];
    const second = loadConfig();
    const secondAccounts = second.routers[0]?.accounts ?? [];

    assert.equal(firstAccounts.length, 1);
    assert.equal(secondAccounts.length, 1);
    assert.equal(secondAccounts[0]?.id, firstAccounts[0]?.id);
  });
});

test('deleting the last account is not undone by the next load', async () => {
  await withSandbox(async () => {
    await seedLegacy();

    const service = new RouterService(new Credentials('file'));
    const router = service.resolve('GoRouter');
    const account = router.accounts[0];
    assert.ok(account);
    await service.removeAccount(router.id, account.id);

    const reloaded = loadConfig();
    assert.equal(reloaded.routers[0]?.accounts.length, 0, 'the migration must not resurrect it');
    assert.equal(reloaded.routers[0]?.activeAccount, undefined);
  });
});
