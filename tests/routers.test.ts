/**
 * Router profiles and their storage (spec §25: config creation, add/edit/delete,
 * duplicate detection, secure key storage, selecting a router).
 *
 * Every case runs in a sandbox, so the assertions about what lands on disk are
 * assertions about real files — including the one that matters most: config.json
 * holds a credential *reference*, never a key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFirstRun, loadConfig, loadState, saveState } from '../src/core/store.ts';
import { paths } from '../src/core/paths.ts';
import { existsSync } from '../src/core/fsx.ts';
import { RouterFlipError } from '../src/errors.ts';
import { sandboxService, withSandbox, TEST_KEY } from './helpers.ts';

test('a fresh machine reports a first run and yields an empty config', async () => {
  await withSandbox(async () => {
    assert.equal(isFirstRun(), true);
    const config = loadConfig();
    assert.deepEqual(config.routers, []);
    assert.equal(config.activeRouter, undefined);
    // Defaults exist without a file being written: reading is never destructive.
    assert.equal(config.settings.credentialBackend, 'auto');
    assert.equal(config.settings.testPath, '/v1/messages');
    assert.equal(existsSync(paths().configFile), false);
  });
});

test('adding a router creates config.json and stores the key out of band', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const router = await service.add({ name: 'Alpha', baseUrl: 'api.alpha.example', apiKey: TEST_KEY });

    assert.equal(router.name, 'Alpha');
    assert.equal(router.baseUrl, 'https://api.alpha.example');
    assert.equal(router.provider, 'claude-code');
    assert.equal(router.authEnvVar, 'ANTHROPIC_API_KEY');

    const raw = readFileSync(paths().configFile, 'utf8');
    assert.equal(raw.includes(TEST_KEY), false, 'config.json must never contain the key');
    assert.equal(raw.includes(router.credentialRef), true);
    assert.equal(isFirstRun(), false);

    // The key itself is retrievable, and the file that holds it is not plaintext.
    assert.equal(await service.apiKey(router), TEST_KEY);
    const vault = readFileSync(paths().credentialsFile, 'utf8');
    assert.equal(vault.includes(TEST_KEY), false, 'the vault must be encrypted at rest');
  });
});

test('the first router added becomes the active one', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const first = await service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: TEST_KEY });
    const second = await service.add({ name: 'Beta', baseUrl: 'b.example', apiKey: TEST_KEY });
    assert.equal(service.activeId, first.id);
    assert.equal(service.setActive(second.name).id, second.id);
    assert.equal(loadConfig().activeRouter, second.id, 'the choice must survive a reload');
  });
});

test('names are trimmed and whitespace-only input is rejected', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const router = await service.add({ name: '  Alpha  ', baseUrl: 'a.example', apiKey: TEST_KEY });
    assert.equal(router.name, 'Alpha');
    await assert.rejects(
      service.add({ name: '   ', baseUrl: 'a.example', apiKey: TEST_KEY }),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'ROUTER_INVALID',
    );
  });
});

test('an empty API key is rejected', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    await assert.rejects(
      service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: '   ' }),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'ROUTER_INVALID',
    );
    assert.equal(service.isEmpty(), true, 'a rejected add must leave nothing behind');
  });
});

test('an invalid base URL is rejected before anything is written', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    await assert.rejects(
      service.add({ name: 'Alpha', baseUrl: 'ftp://files.example', apiKey: TEST_KEY }),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'INVALID_URL',
    );
    assert.equal(existsSync(paths().configFile), false);
  });
});

test('duplicate names are refused, case-insensitively', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    await service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: TEST_KEY });
    for (const name of ['Alpha', 'alpha', '  ALPHA  ']) {
      await assert.rejects(
        service.add({ name, baseUrl: 'other.example', apiKey: TEST_KEY }),
        (error: unknown) => error instanceof RouterFlipError && error.code === 'ROUTER_DUPLICATE',
      );
    }
    assert.equal(service.list().length, 1);
  });
});

test('editing changes only what was passed', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const router = await service.add({
      name: 'Alpha',
      baseUrl: 'a.example',
      apiKey: TEST_KEY,
      description: 'Primary',
    });

    const renamed = await service.update(router.id, { name: 'Alpha Prime', baseUrl: 'new.example/v1' });
    assert.equal(renamed.name, 'Alpha Prime');
    assert.equal(renamed.baseUrl, 'https://new.example');
    assert.equal(renamed.description, 'Primary', 'an omitted field must be left alone');
    assert.equal(await service.apiKey(renamed), TEST_KEY, 'an omitted key must be left alone');
    assert.notEqual(renamed.updatedAt, undefined);
  });
});

test('editing can replace the stored key', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const router = await service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: TEST_KEY });
    const updated = await service.update(router.id, { apiKey: 'sk-replacement-9876543210' });
    assert.equal(await service.apiKey(updated), 'sk-replacement-9876543210');
    assert.equal(readFileSync(paths().configFile, 'utf8').includes('sk-replacement'), false);
  });
});

test('editing cannot take another router name', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    await service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: TEST_KEY });
    const beta = await service.add({ name: 'Beta', baseUrl: 'b.example', apiKey: TEST_KEY });
    await assert.rejects(
      service.update(beta.id, { name: 'Alpha' }),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'ROUTER_DUPLICATE',
    );
    // Renaming to the same name with different case is allowed: it is the same row.
    assert.equal((await service.update(beta.id, { name: 'beta' })).name, 'beta');
  });
});

test('an empty replacement key is refused', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const router = await service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: TEST_KEY });
    await assert.rejects(service.update(router.id, { apiKey: '  ' }), RouterFlipError);
    assert.equal(await service.apiKey(router), TEST_KEY);
  });
});

test('deleting removes the profile, its key, and any activation record', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    const alpha = await service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: TEST_KEY });
    const beta = await service.add({ name: 'Beta', baseUrl: 'b.example', apiKey: TEST_KEY });

    saveState({
      ...loadState(),
      activation: {
        routerId: alpha.id,
        routerName: alpha.name,
        provider: 'claude-code',
        appliedAt: '2026-01-01T00:00:00.000Z',
        targetFile: join('nowhere', 'settings.json'),
        managedKeys: ['env.ANTHROPIC_BASE_URL'],
        preexisting: {},
      },
    });

    await service.remove(alpha.name);
    assert.equal(service.find('Alpha'), undefined);
    assert.equal(await credentials.get(alpha.credentialRef), undefined, 'the key must go with the profile');
    assert.equal(loadState().activation, undefined, 'a deleted router must not stay activated');
    assert.equal(service.activeId, beta.id, 'the active pointer must move to a surviving router');
  });
});

test('lookup works by name, id and case, and fails helpfully otherwise', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const router = await service.add({ name: 'Alpha Router', baseUrl: 'a.example', apiKey: TEST_KEY });
    assert.equal(service.find('Alpha Router')?.id, router.id);
    assert.equal(service.find('alpha router')?.id, router.id);
    assert.equal(service.find(router.id)?.id, router.id);
    assert.equal(service.find('nope'), undefined);
    assert.throws(
      () => service.resolve('Gamma'),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'ROUTER_NOT_FOUND',
    );
  });
});

test('resolve on an empty config says "no routers", not "not found"', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    assert.throws(
      () => service.resolve('Alpha'),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'NO_ROUTERS',
    );
  });
});

test('a view is print-safe: masked key, no secret anywhere', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const router = await service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: TEST_KEY });
    const view = await service.view(router);
    assert.equal(view.hasKey, true);
    assert.equal(view.isActive, true);
    assert.equal(view.maskedKey.includes('0123456789'), false);
    assert.equal(JSON.stringify(view).includes(TEST_KEY), false);
  });
});

test('a missing key is reported as absent rather than crashing', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    const router = await service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: TEST_KEY });
    await credentials.remove(router.credentialRef);

    assert.equal(await service.hasKey(router), false);
    const view = await service.view(router);
    assert.equal(view.hasKey, false);
    assert.equal(view.maskedKey.length > 0, true, 'the field is still masked, not blank');
    await assert.rejects(
      service.apiKey(router),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'CREDENTIAL_MISSING',
    );
  });
});

test('a corrupt config.json is reported, never silently replaced', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    await service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: TEST_KEY });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(paths().configFile, '{ this is not json', 'utf8');
    assert.throws(
      () => loadConfig(),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'CONFIG_INVALID',
    );
  });
});

test('a corrupt state.json resets instead of bricking the CLI', async () => {
  await withSandbox(async () => {
    const { writeFileSync } = await import('node:fs');
    saveState({ ...loadState(), lastUsedRouterId: 'alpha-1' });
    writeFileSync(paths().stateFile, '{ nope', 'utf8');
    assert.equal(loadState().lastUsedRouterId, undefined);
  });
});

test('saving config keeps a timestamped backup of the previous version', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    await service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: TEST_KEY });
    await service.add({ name: 'Beta', baseUrl: 'b.example', apiKey: TEST_KEY });
    const { readdirSync } = await import('node:fs');
    const backups = readdirSync(paths().backupsDir).filter((name) => name.startsWith('config-'));
    assert.equal(backups.length >= 1, true);
  });
});
