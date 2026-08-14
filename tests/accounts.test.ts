/**
 * Multiple accounts per router.
 *
 * One rule is under test throughout: **the router owns the base URL, the account
 * owns the key.** Every case therefore checks a pair — that the URL came from the
 * router and the credential from the account that was chosen — rather than just
 * that a launch happened.
 *
 * The security rules are asserted as facts about real files inside the sandbox:
 * config.json never contains a key, a view never carries one, and deleting an
 * account really removes its entry from the credential store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Credentials } from '../src/credentials/index.ts';
import { credentialRefOf } from '../src/core/accounts.ts';
import { paths } from '../src/core/paths.ts';
import { RouterService } from '../src/core/routers.ts';
import type { Account, Router } from '../src/core/schema.ts';
import { loadConfig, loadState } from '../src/core/store.ts';
import { RouterFlipError } from '../src/errors.ts';
import { claudeCode } from '../src/providers/claude-code.ts';
import { applyPermanent } from '../src/services/activation.ts';
import { launchRouter } from '../src/services/launcher.ts';
import { fakeSpawn, sandboxService, withSandbox, TEST_KEY } from './helpers.ts';

/** Three distinct keys, so "which credential was used?" has a single answer. */
const SECOND_KEY = 'sk-second-abcdef0123456789';
const THIRD_KEY = 'sk-third-fedcba9876543210';

/** The mockup's router: one gateway, three accounts, the first one selected. */
async function seedThree(service: RouterService): Promise<Router> {
  const router = await service.add({ name: 'GoRouter', baseUrl: 'api.gorouter.example', apiKey: TEST_KEY });
  await service.addAccount(router.id, { name: 'Account 2', apiKey: SECOND_KEY });
  await service.addAccount(router.id, { name: 'Account 3', apiKey: THIRD_KEY });
  return service.resolve(router.id);
}

/** The nth account, with the assertion that it exists folded in. */
function nth(router: Router, index: number): Account {
  const account = router.accounts[index];
  assert.ok(account, `expected an account at position ${index + 1}`);
  return account;
}

/** config.json as text, for the assertions that no key ever reaches it. */
function rawConfig(): string {
  return readFileSync(paths().configFile, 'utf8');
}

// ── One account ───────────────────────────────────────────────────────────────

test('a freshly added router has exactly one account, holding its key', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const router = await service.add({ name: 'GoRouter', baseUrl: 'api.gorouter.example', apiKey: TEST_KEY });

    assert.equal(router.accounts.length, 1);
    const account = nth(router, 0);
    assert.equal(account.name, 'Account 1');
    // The same ref the router itself carries: this is what lets the version 1
    // migration wrap an existing credential without moving it.
    assert.equal(account.credentialRef, router.credentialRef);
    assert.equal(router.activeAccount, account.id);

    assert.equal(await service.apiKey(router), TEST_KEY, 'no account named means the selected one');
    assert.equal(await service.apiKey(router, account), TEST_KEY);
    // The router owns the URL, so an account must not carry a copy of it.
    assert.equal('baseUrl' in account, false);
    assert.equal(Object.keys(account).includes('baseUrl'), false);
  });
});

// ── Several accounts ──────────────────────────────────────────────────────────

test('each account owns its own credential under one shared base URL', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const router = await seedThree(service);

    assert.equal(router.accounts.length, 3);
    assert.deepEqual(router.accounts.map((account) => account.name), ['Account 1', 'Account 2', 'Account 3']);

    const refs = router.accounts.map((account) => account.credentialRef);
    assert.equal(new Set(refs).size, 3, 'two accounts sharing a ref would overwrite each other');
    assert.equal(await service.apiKey(router, nth(router, 0)), TEST_KEY);
    assert.equal(await service.apiKey(router, nth(router, 1)), SECOND_KEY);
    assert.equal(await service.apiKey(router, nth(router, 2)), THIRD_KEY);

    // One URL for all three, and no account carries a second copy of it.
    assert.equal(router.baseUrl, 'https://api.gorouter.example');
    for (const account of router.accounts) assert.equal('baseUrl' in account, false);
  });
});

// ── Add ───────────────────────────────────────────────────────────────────────

test('adding an account stores the key out of band and changes nothing else', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    const created = await service.add({ name: 'GoRouter', baseUrl: 'api.gorouter.example', apiKey: TEST_KEY });
    const added = await service.addAccount(created.id, { name: 'Account 2', apiKey: SECOND_KEY, description: 'work' });

    const router = service.resolve(created.id);
    assert.equal(router.accounts.length, 2);
    assert.equal(added.description, 'work');
    assert.equal(await credentials.get(added.credentialRef), SECOND_KEY);

    // Adding must never silently move the key a launch would use.
    assert.equal(router.activeAccount, nth(router, 0).id);
    assert.equal(await service.apiKey(router), TEST_KEY);

    const raw = rawConfig();
    assert.equal(raw.includes(TEST_KEY), false, 'config.json must never contain a key');
    assert.equal(raw.includes(SECOND_KEY), false);
    assert.equal(raw.includes(added.credentialRef), true, 'only the reference is written');
  });
});

test('an account added to an emptied router reuses the router credential slot', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const created = await service.add({ name: 'GoRouter', baseUrl: 'api.gorouter.example', apiKey: TEST_KEY });
    await service.removeAccount(created.id, nth(created, 0).id);

    const revived = await service.addAccount(created.id, { name: 'Fresh', apiKey: SECOND_KEY });
    const router = service.resolve(created.id);
    assert.equal(revived.credentialRef, router.credentialRef, 'no permanently dangling router ref');
    assert.equal(router.activeAccount, revived.id, 'the first account of a router is selected for it');
    assert.equal(await service.apiKey(router), SECOND_KEY);
  });
});

// ── Edit ──────────────────────────────────────────────────────────────────────

test('renaming an account and replacing its key leaves the credential in place', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedThree(service);
    const second = nth(seeded, 1);

    const updated = await service.updateAccount(seeded.id, second.id, { name: 'Work', apiKey: 'sk-rotated-0123456789' });
    const router = service.resolve(seeded.id);

    assert.equal(updated.name, 'Work');
    // The ref is derived from the id, which a rename does not touch, so the key
    // cannot be orphaned by renaming.
    assert.equal(updated.credentialRef, second.credentialRef);
    assert.equal(await service.apiKey(router, updated), 'sk-rotated-0123456789');
    assert.notEqual(updated.updatedAt, second.updatedAt);

    // The other accounts are untouched by an edit to this one.
    assert.equal(await service.apiKey(router, nth(router, 0)), TEST_KEY);
    assert.equal(await service.apiKey(router, nth(router, 2)), THIRD_KEY);
    assert.equal(rawConfig().includes('sk-rotated'), false);
  });
});

test('editing only the description keeps the stored key', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedThree(service);
    const second = nth(seeded, 1);

    const updated = await service.updateAccount(seeded.id, second.id, { description: 'billing' });
    assert.equal(updated.name, 'Account 2', 'an omitted field must be left alone');
    assert.equal(updated.description, 'billing');
    assert.equal(await service.apiKey(service.resolve(seeded.id), updated), SECOND_KEY);
  });
});

test('an empty replacement key is refused', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedThree(service);
    const second = nth(seeded, 1);
    await assert.rejects(
      service.updateAccount(seeded.id, second.id, { apiKey: '   ' }),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'ROUTER_INVALID',
    );
    assert.equal(await service.apiKey(service.resolve(seeded.id), second), SECOND_KEY);
  });
});

// ── Delete ────────────────────────────────────────────────────────────────────

test('deleting an account removes its credential-store entry, and only its own', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    const seeded = await seedThree(service);
    const second = nth(seeded, 1);

    await service.removeAccount(seeded.id, second.id);
    const router = service.resolve(seeded.id);

    assert.equal(router.accounts.length, 2);
    assert.equal(router.accounts.some((account) => account.id === second.id), false);
    assert.equal(await credentials.get(second.credentialRef), undefined, 'the key must go with the account');
    // The neighbours keep theirs.
    assert.equal(await service.apiKey(router, nth(router, 0)), TEST_KEY);
    assert.equal(await service.apiKey(router, nth(router, 1)), THIRD_KEY);
    assert.equal(loadConfig().routers[0]?.accounts.length, 2, 'the deletion is on disk');
  });
});

test('deleting the active account selects a survivor rather than nothing', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedThree(service);
    const second = nth(seeded, 1);
    service.setActiveAccount(seeded.id, second.id);

    await service.removeAccount(seeded.id, second.id);
    const router = service.resolve(seeded.id);
    const active = service.activeAccountOf(router);

    assert.ok(active);
    assert.equal(active.id, nth(router, 0).id, 'the selection falls to the first survivor');
    assert.equal(router.activeAccount, active.id, 'and is written, not merely inferred');
    assert.equal(await service.apiKey(router), TEST_KEY);
  });
});

// ── Duplicates ────────────────────────────────────────────────────────────────

test('two accounts of one router cannot share a name, case-insensitively', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedThree(service);
    for (const name of ['Account 2', 'account 2', '  ACCOUNT 2  ']) {
      await assert.rejects(
        service.addAccount(seeded.id, { name, apiKey: SECOND_KEY }),
        (error: unknown) => error instanceof RouterFlipError && error.code === 'ROUTER_DUPLICATE',
      );
    }
    assert.equal(service.resolve(seeded.id).accounts.length, 3, 'a refused add leaves nothing behind');

    // Renaming into a sibling's name is refused for the same reason.
    await assert.rejects(
      service.updateAccount(seeded.id, nth(seeded, 2).id, { name: 'Account 2' }),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'ROUTER_DUPLICATE',
    );
  });
});

test('names that slugify alike still get distinct ids and distinct keys', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const created = await service.add({ name: 'GoRouter', baseUrl: 'api.gorouter.example', apiKey: TEST_KEY });
    // Different names — so both are allowed — that produce the same slug.
    const a = await service.addAccount(created.id, { name: 'Work Laptop', apiKey: SECOND_KEY });
    const b = await service.addAccount(created.id, { name: 'Work-Laptop', apiKey: THIRD_KEY });

    assert.notEqual(a.id, b.id);
    assert.notEqual(a.credentialRef, b.credentialRef);
    const router = service.resolve(created.id);
    assert.equal(await service.apiKey(router, a), SECOND_KEY);
    assert.equal(await service.apiKey(router, b), THIRD_KEY, 'a colliding id would have overwritten this');
  });
});

// ── Selecting the pair ────────────────────────────────────────────────────────

test('selecting an account selects both halves and survives a reload', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const other = await service.add({ name: 'Other', baseUrl: 'api.other.example', apiKey: 'sk-other-0123456789ab' });
    const seeded = await seedThree(service);
    service.setActive(other.id);

    const { router, account } = service.setActiveAccount(seeded.id, 'Account 2');
    assert.equal(account.name, 'Account 2');
    assert.equal(router.activeAccount, account.id);
    assert.equal(service.activeId, seeded.id, 'choosing an account also makes its router current');

    // A second process reads the same pair back out of config.json.
    const reloaded = new RouterService(new Credentials('file'));
    const again = reloaded.resolve('GoRouter');
    assert.equal(reloaded.activeId, seeded.id);
    assert.equal(reloaded.activeAccountOf(again)?.name, 'Account 2');
    assert.equal(await reloaded.apiKey(again), SECOND_KEY, 'the selected pair decides the key');
  });
});

test('an account can be selected by name, id or 1-based position', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedThree(service);
    const third = nth(seeded, 2);

    assert.equal(service.findAccount(seeded, 'Account 3')?.id, third.id);
    assert.equal(service.findAccount(seeded, 'account 3')?.id, third.id);
    assert.equal(service.findAccount(seeded, third.id)?.id, third.id);
    assert.equal(service.findAccount(seeded, '3')?.id, third.id, '`--account 3` is the printed numbering');
    assert.equal(service.findAccount(seeded, '4'), undefined);
    assert.throws(
      () => service.resolveAccount(seeded, 'Nope'),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'ROUTER_NOT_FOUND',
    );
  });
});

test('a selection pointing at a deleted account is ignored, not obeyed', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedThree(service);
    // Hand-edited config: `activeAccount` names something that is not there.
    const patched: Router = { ...seeded, activeAccount: 'account-gone' };
    assert.equal(service.activeAccountOf(patched)?.name, 'Account 1', 'fall back to the first account');
    assert.equal(credentialRefOf(patched), nth(seeded, 0).credentialRef);
  });
});

// ── Temporary mode ────────────────────────────────────────────────────────────

test('a temporary launch pairs the router URL with the chosen account key', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedThree(service);
    const { router, account } = service.setActiveAccount(seeded.id, 'Account 2');
    const before = { ...process.env };

    const spawner = fakeSpawn();
    const pending = launchRouter({
      router,
      apiKey: await service.apiKey(router, account),
      provider: claudeCode,
      executable: '/usr/local/bin/claude',
      spawnFn: spawner.spawnFn,
      baseEnv: { PATH: '/usr/bin' },
    });
    spawner.child().emit('close', 0, null);
    await pending;

    const call = spawner.calls[0];
    assert.ok(call);
    const env = call.options.env as NodeJS.ProcessEnv;
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.gorouter.example', 'the URL is the router’s');
    assert.equal(env.ANTHROPIC_API_KEY, SECOND_KEY, 'the key is the selected account’s');
    assert.deepEqual({ ...process.env }, before, 'process.env must be identical after a temporary launch');
  });
});

test('a different account of the same router launches with a different key', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedThree(service);
    const third = nth(seeded, 2);

    const spawner = fakeSpawn();
    const pending = launchRouter({
      router: seeded,
      apiKey: await service.apiKey(seeded, third),
      provider: claudeCode,
      executable: '/usr/local/bin/claude',
      spawnFn: spawner.spawnFn,
    });
    spawner.child().emit('close', 0, null);
    await pending;

    const env = spawner.calls[0]?.options.env as NodeJS.ProcessEnv;
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.gorouter.example', 'same gateway');
    assert.equal(env.ANTHROPIC_API_KEY, THIRD_KEY, 'other credential');
  });
});

// ── Permanent mode ────────────────────────────────────────────────────────────

test('permanent mode writes the chosen account’s key and records which one', async () => {
  await withSandbox(async (sandbox) => {
    const { service } = sandboxService();
    const seeded = await seedThree(service);
    const { router, account } = service.setActiveAccount(seeded.id, 'Account 2');

    const outcome = applyPermanent({
      router,
      apiKey: await service.apiKey(router, account),
      provider: claudeCode,
      strategy: 'env',
      account,
    });

    const settings = JSON.parse(readFileSync(sandbox.settingsFile, 'utf8')) as Record<string, unknown>;
    const env = settings.env as Record<string, unknown>;
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.gorouter.example');
    assert.equal(env.ANTHROPIC_API_KEY, SECOND_KEY, 'the account that was chosen is the one applied');
    assert.equal(String(env.ANTHROPIC_API_KEY).includes(TEST_KEY), false);

    assert.equal(outcome.activation.accountId, account.id);
    assert.equal(outcome.activation.accountName, 'Account 2');
    const state = loadState();
    assert.equal(state.activation?.accountId, account.id, 'the record survives for `current` to read');
    assert.equal(state.activation?.routerId, router.id);
    assert.equal(state.lastUsedRouterId, router.id);
    assert.equal(readFileSync(paths().stateFile, 'utf8').includes(SECOND_KEY), false, 'state.json holds no key');
  });
});

test('the helper strategy fetches the chosen account rather than embedding its key', async () => {
  await withSandbox(async (sandbox) => {
    const { service } = sandboxService();
    const seeded = await seedThree(service);
    const { router, account } = service.setActiveAccount(seeded.id, 'Account 2');

    const outcome = applyPermanent({
      router,
      apiKey: await service.apiKey(router, account),
      provider: claudeCode,
      strategy: 'helper',
      account,
    });

    const raw = readFileSync(sandbox.settingsFile, 'utf8');
    if (outcome.result.strategy === 'helper') {
      assert.equal(raw.includes(SECOND_KEY), false, 'the secret stays in the OS credential store');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      assert.match(String(settings.apiKeyHelper), new RegExp(`--account ${account.id}$`));
      assert.deepEqual(outcome.result.managedKeys, ['env.ANTHROPIC_BASE_URL', 'apiKeyHelper']);
    } else {
      // Documented fallback: no `routerflip` on PATH means no helper is runnable.
      assert.equal(outcome.result.strategy, 'env');
      assert.equal(raw.includes(SECOND_KEY), true);
    }
    assert.equal(outcome.activation.accountName, 'Account 2');
  });
});

// ── Masking ───────────────────────────────────────────────────────────────────

test('an account view carries a mask, never the key', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedThree(service);
    const views = await service.accountViews(seeded);

    assert.equal(views.length, 3);
    const serialized = JSON.stringify(views);
    for (const key of [TEST_KEY, SECOND_KEY, THIRD_KEY]) {
      assert.equal(serialized.includes(key), false, 'a view is print-safe');
    }
    const second = views[1];
    assert.ok(second);
    assert.equal(second.hasKey, true);
    assert.equal(second.maskedKey.endsWith(SECOND_KEY.slice(-4)), true, 'the last 4 tell two keys apart');
    assert.equal(second.maskedKey.includes(SECOND_KEY.slice(0, 8)), false);
    assert.equal(views[0]?.isActive, true, 'exactly the selected account is marked');
    assert.equal(second.isActive, false);
  });
});

test('a router view masks the key of the account that would be used', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedThree(service);
    const { router } = service.setActiveAccount(seeded.id, 'Account 3');

    const view = await service.view(router);
    assert.equal(view.accountCount, 3);
    assert.equal(view.activeAccountName, 'Account 3');
    assert.equal(view.maskedKey.endsWith(THIRD_KEY.slice(-4)), true);
    assert.equal(JSON.stringify(view).includes(THIRD_KEY), false);

    // An explicit account overrides the selection, so `--account` shows the mask
    // of the key it is actually going to use.
    const other = await service.view(router, nth(router, 1));
    assert.equal(other.activeAccountName, 'Account 2');
    assert.equal(other.maskedKey.endsWith(SECOND_KEY.slice(-4)), true);
  });
});

test('an account with no stored key is reported as absent, not crashed on', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    const seeded = await seedThree(service);
    const second = nth(seeded, 1);
    await credentials.remove(second.credentialRef);

    const view = await service.accountView(seeded, second);
    assert.equal(view.hasKey, false);
    assert.equal(view.maskedKey.length > 0, true, 'the field is still masked, not blank');
    await assert.rejects(
      service.apiKey(seeded, second),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'CREDENTIAL_MISSING',
    );
    assert.equal(await service.hasKey(seeded, nth(seeded, 0)), true, 'the others are unaffected');
  });
});

// ── No accounts left ──────────────────────────────────────────────────────────

test('a router whose last account was deleted is empty, not broken', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    const created = await service.add({ name: 'GoRouter', baseUrl: 'api.gorouter.example', apiKey: TEST_KEY });
    const only = nth(created, 0);
    await service.removeAccount(created.id, only.id);
    const router = service.resolve(created.id);

    assert.deepEqual(router.accounts, []);
    assert.equal(router.activeAccount, undefined, 'no selection is left dangling');
    assert.equal(service.activeAccountOf(router), undefined);
    assert.deepEqual(await service.accountViews(router), []);
    assert.equal(await credentials.get(only.credentialRef), undefined);

    // The router itself is still a valid profile: the URL is intact, and the
    // credential lookup falls back to the router's own ref exactly as it did
    // before accounts existed.
    assert.equal(router.baseUrl, 'https://api.gorouter.example');
    assert.equal(credentialRefOf(router), router.credentialRef);
    assert.equal(await service.hasKey(router), false);
    await assert.rejects(
      service.apiKey(router),
      (error: unknown) => error instanceof RouterFlipError && error.code === 'CREDENTIAL_MISSING',
    );
  });
});

test('naming an account of a router that has none says so', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const created = await service.add({ name: 'GoRouter', baseUrl: 'api.gorouter.example', apiKey: TEST_KEY });
    await service.removeAccount(created.id, nth(created, 0).id);
    const router = service.resolve(created.id);

    assert.equal(service.findAccount(router, '1'), undefined);
    assert.throws(
      () => service.resolveAccount(router, 'Account 1'),
      (error: unknown) => error instanceof RouterFlipError && /has no accounts yet/.test(error.message),
    );
    const view = await service.view(router);
    assert.equal(view.accountCount, 0);
    assert.equal(view.activeAccountName, undefined);
    assert.equal(view.hasKey, false);
  });
});
