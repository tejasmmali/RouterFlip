/**
 * Optional model selection, and the `M` shortcut that changes it.
 *
 * The rule under test throughout is the split the feature is built on: **the model
 * list belongs to the router and the selection belongs to the account.** A router
 * describes what its endpoint serves, so every account of it offers the same
 * choices, while "which one did I use last" is a property of one credential.
 *
 * The second rule is that choosing is never compulsory. No screen forces a model,
 * "no model" means "whatever the provider already defaults to", and a router that
 * has never been given one produces exactly the environment it produced before
 * models existed — which is why several assertions here are about what is *absent*.
 *
 * The keyboard half runs on the virtual terminal from `fake-terminal.ts`, because
 * the requirement is a claim about what the user sees and about who owns stdin: `M`
 * opens the picker over the screen it was opened from, a name field treats `M` as
 * the letter M, and however often the picker is opened there is one reader on stdin
 * and one alternate-buffer switch for the whole session.
 *
 * Nothing here reads, writes or prints a key: the model half of a router is
 * non-secret, and that it stays that way is asserted too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chooseModel } from '../src/commands/models.ts';
import type { AppContext } from '../src/context.ts';
import { paths } from '../src/core/paths.ts';
import { RouterService } from '../src/core/routers.ts';
import type { Account, Router } from '../src/core/schema.ts';
import { Credentials } from '../src/credentials/index.ts';
import { RouterFlipError, isCancelled } from '../src/errors.ts';
import { activationFrom, claudeCode } from '../src/providers/claude-code.ts';
import type { ApplyResult } from '../src/providers/types.ts';
import { launchRouter } from '../src/services/launcher.ts';
import { ESC } from '../src/ui/ansi.ts';
import { isShortcut } from '../src/ui/keys.ts';
import { password, select, text } from '../src/ui/prompts.ts';
import { runScreen, withInlineView } from '../src/ui/screen.ts';
import { fakeSpawn, makeRouter, sandboxService, withSandbox, TEST_KEY, type Sandbox } from './helpers.ts';
import { press, readers, settle, SHELL_LINE, withFakeTerminal } from './fake-terminal.ts';

/** Distinct keys, so "which credential was used?" always has a single answer. */
const SECOND_KEY = 'sk-second-abcdef0123456789';
const THIRD_KEY = 'sk-third-fedcba9876543210';

/** The mockup's models, in the order the picker would list them. */
const FIRST_MODEL = 'GPT-5.6';
const SECOND_MODEL = 'Opus 4.8';
const THIRD_MODEL = 'GPT-5';

/** The mockup's router: one gateway, three accounts, the first one selected. */
async function seedRouter(service: RouterService): Promise<Router> {
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

/** The model an account remembers, read back from disk rather than from a return. */
function modelOnDisk(service: RouterService, routerId: string, accountId: string): string | undefined {
  const router = service.resolve(routerId);
  return service.resolveAccount(router, accountId).model;
}

// ── The list is the router's ──────────────────────────────────────────────────

test('every account of a router offers the same models, and none owns a list', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedRouter(service);
    service.addModel(seeded.id, FIRST_MODEL);
    service.addModel(seeded.id, SECOND_MODEL);

    const router = service.resolve(seeded.id);
    assert.deepEqual([...router.models], [FIRST_MODEL, SECOND_MODEL]);
    // The offer is the router's, so it is the same offer whichever account is asked
    // about — this is what "all accounts share the router's model list" means.
    for (const account of router.accounts) {
      assert.deepEqual([...router.models], [FIRST_MODEL, SECOND_MODEL], `${account.name} sees the same list`);
      assert.equal('models' in account, false, 'an account must not carry a list of its own');
    }
    // Adding the same model twice is a no-op rather than a duplicate row.
    service.addModel(router.id, 'gpt-5.6');
    assert.deepEqual([...service.resolve(router.id).models], [FIRST_MODEL, SECOND_MODEL]);
  });
});

test('a model selected on one account is offered to its siblings without being selected there', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedRouter(service);
    const second = nth(seeded, 1);

    // Selecting something the router has never offered registers it on the router:
    // the list is shared, so a choice made once is available to every account.
    service.setAccountModel(seeded.id, second.id, SECOND_MODEL);
    const router = service.resolve(seeded.id);

    assert.deepEqual([...router.models], [SECOND_MODEL], 'the router learned the model');
    assert.equal(service.modelOf(router, nth(router, 1)), SECOND_MODEL);
    assert.equal(service.modelOf(router, nth(router, 0)), undefined, 'a sibling is offered it, not given it');
    assert.equal(service.modelOf(router, nth(router, 2)), undefined);
  });
});

// ── The selection is the account's ────────────────────────────────────────────

test('each account remembers its own model, and the choice survives a reload', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedRouter(service);
    service.setAccountModel(seeded.id, nth(seeded, 0).id, FIRST_MODEL);
    service.setAccountModel(seeded.id, nth(seeded, 1).id, SECOND_MODEL);
    service.setAccountModel(seeded.id, nth(seeded, 2).id, THIRD_MODEL);

    // A second process reads the same three selections back out of config.json.
    const reloaded = new RouterService(new Credentials('file'));
    const router = reloaded.resolve('GoRouter');
    assert.equal(reloaded.modelOf(router, nth(router, 0)), FIRST_MODEL);
    assert.equal(reloaded.modelOf(router, nth(router, 1)), SECOND_MODEL);
    assert.equal(reloaded.modelOf(router, nth(router, 2)), THIRD_MODEL);
    assert.equal(new Set(router.accounts.map((account) => account.model)).size, 3, 'three accounts, three answers');
    assert.deepEqual([...router.models], [FIRST_MODEL, SECOND_MODEL, THIRD_MODEL], 'one list, three selections');

    // With no account named, the selected pair is the one that answers — which is
    // what the action screen shows and what a launch would use.
    assert.equal(reloaded.modelOf(router), FIRST_MODEL, 'Account 1 is the selected account');
    const { router: switched } = reloaded.setActiveAccount(router.id, 'Account 2');
    assert.equal(reloaded.modelOf(switched), SECOND_MODEL, 'switching account switches the remembered model');
  });
});

test('choosing again replaces the remembered model, and clearing it withdraws nothing', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedRouter(service);
    const account = nth(seeded, 0);

    service.setAccountModel(seeded.id, account.id, FIRST_MODEL);
    assert.equal(modelOnDisk(service, seeded.id, account.id), FIRST_MODEL);

    service.setAccountModel(seeded.id, account.id, SECOND_MODEL);
    assert.equal(modelOnDisk(service, seeded.id, account.id), SECOND_MODEL, 'the later choice wins');
    assert.deepEqual([...service.resolve(seeded.id).models], [FIRST_MODEL, SECOND_MODEL], 'both stay on offer');

    // Clearing is a legitimate choice, not a gap: the account goes back to the
    // provider's own default while the router keeps offering both models.
    service.setAccountModel(seeded.id, account.id, undefined);
    assert.equal(modelOnDisk(service, seeded.id, account.id), undefined);
    assert.deepEqual([...service.resolve(seeded.id).models], [FIRST_MODEL, SECOND_MODEL]);
  });
});

test('withdrawing a model clears it from every account that had chosen it', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedRouter(service);
    service.setAccountModel(seeded.id, nth(seeded, 0).id, SECOND_MODEL);
    service.setAccountModel(seeded.id, nth(seeded, 1).id, SECOND_MODEL);
    service.setAccountModel(seeded.id, nth(seeded, 2).id, FIRST_MODEL);

    service.removeModel(seeded.id, SECOND_MODEL);
    const router = service.resolve(seeded.id);

    assert.deepEqual([...router.models], [FIRST_MODEL], 'the list is the router’s, so it shrinks once');
    // An account must never be left remembering something the picker cannot show.
    assert.equal(service.modelOf(router, nth(router, 0)), undefined);
    assert.equal(service.modelOf(router, nth(router, 1)), undefined);
    assert.equal(service.modelOf(router, nth(router, 2)), FIRST_MODEL, 'a different choice is untouched');
  });
});

// ── No model at all ───────────────────────────────────────────────────────────

test('a first-time account has no model, and launches exactly as it did before models existed', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const created = await service.add({ name: 'GoRouter', baseUrl: 'api.gorouter.example', apiKey: TEST_KEY });
    const account = nth(created, 0);

    assert.equal(account.model, undefined, 'nothing is chosen on the user’s behalf');
    assert.deepEqual([...created.models], [], 'and nothing is invented for the router either');
    assert.equal(service.modelOf(created, account), undefined);
    assert.equal(service.modelOf(created), undefined);

    // The provider sets no model variable on a guess, so the child environment is
    // byte-for-byte the one a pre-models RouterFlip produced.
    assert.deepEqual([...claudeCode.envKeys(created)], ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']);
    assert.deepEqual(Object.keys(claudeCode.envFor(created, TEST_KEY)), ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']);

    const view = await service.view(created);
    assert.equal(view.model, undefined, 'the action screen has nothing to show, and says so rather than asking');
    assert.deepEqual([...view.models], []);
  });
});

test('naming a model the router does not offer explains itself instead of guessing', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedRouter(service);

    // `--model X` on a router with an empty list: the fix is named, not applied.
    assert.throws(
      () => service.resolveModel(seeded, THIRD_MODEL),
      (error: unknown) =>
        error instanceof RouterFlipError && error.code === 'ROUTER_NOT_FOUND' && /has no models configured yet/.test(error.message),
    );

    service.addModel(seeded.id, FIRST_MODEL);
    const router = service.resolve(seeded.id);
    assert.throws(
      () => service.resolveModel(router, THIRD_MODEL),
      (error: unknown) => error instanceof RouterFlipError && new RegExp(FIRST_MODEL.replace('.', '\\.')).test(error.hint ?? ''),
    );

    // What does resolve, resolves to the stored spelling rather than a second entry.
    assert.equal(service.resolveModel(router, 'gpt-5.6'), FIRST_MODEL, 'case-insensitive');
    assert.equal(service.resolveModel(router, '1'), FIRST_MODEL, 'the position the picker prints');
    assert.deepEqual([...service.resolve(router.id).models], [FIRST_MODEL], 'no lookup ever grew the list');
  });
});

// ── Temporary mode ────────────────────────────────────────────────────────────

test('a launch pins the account’s model, and pins nothing when it has none', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedRouter(service);
    const { router, account: selected } = service.setActiveAccount(seeded.id, 'Account 2');
    service.setAccountModel(router.id, selected.id, SECOND_MODEL);
    // Re-read, because a launch works from what is on disk rather than from the
    // account object that happened to be in hand when the choice was made.
    const withModel = service.resolve(router.id);
    const account = service.resolveAccount(withModel, selected.id);
    const before = { ...process.env };

    const launch = async (model?: string): Promise<NodeJS.ProcessEnv> => {
      const spawner = fakeSpawn();
      const pending = launchRouter({
        router: withModel,
        apiKey: await service.apiKey(withModel, account),
        provider: claudeCode,
        executable: '/usr/local/bin/claude',
        spawnFn: spawner.spawnFn,
        baseEnv: { PATH: '/usr/bin' },
        ...(model ? { model } : {}),
      });
      spawner.child().emit('close', 0, null);
      await pending;
      return spawner.calls[0]?.options.env as NodeJS.ProcessEnv;
    };

    const pinned = await launch(service.modelOf(withModel, account));
    assert.equal(pinned.ANTHROPIC_MODEL, SECOND_MODEL, 'the remembered model reaches the child');
    assert.equal(pinned.ANTHROPIC_BASE_URL, 'https://api.gorouter.example', 'the URL is still the router’s');
    assert.equal(pinned.ANTHROPIC_API_KEY, SECOND_KEY, 'and the key still the account’s');

    const bare = await launch(undefined);
    assert.equal(bare.ANTHROPIC_MODEL, undefined, 'no model means no variable, not an empty one');
    assert.equal('ANTHROPIC_MODEL' in bare, false);
    assert.deepEqual({ ...process.env }, before, 'process.env must be identical after a temporary launch');
  });
});

// ── Permanent mode ────────────────────────────────────────────────────────────

/** A settings.json whose own `model` key RouterFlip has no business touching. */
const EXISTING_SETTINGS = { model: 'opusplan', env: { MY_OWN_VAR: 'keep-me' } };

function writeSettings(sandbox: Sandbox, value: unknown): void {
  mkdirSync(sandbox.claudeDir, { recursive: true });
  writeFileSync(sandbox.settingsFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readSettings(sandbox: Sandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(sandbox.settingsFile, 'utf8')) as Record<string, unknown>;
}

test('a permanent apply pins the chosen model, and a later one without a model retires it', async () => {
  await withSandbox(async (sandbox) => {
    writeSettings(sandbox, EXISTING_SETTINGS);
    const router = makeRouter({ baseUrl: 'https://api.gorouter.example', models: [FIRST_MODEL, SECOND_MODEL] });
    const options = { backupsDir: paths().backupsDir, strategy: 'env' } as const;

    const first: ApplyResult = claudeCode.applyPermanent(router, TEST_KEY, { ...options, model: SECOND_MODEL });
    assert.deepEqual(first.managedKeys, ['env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_API_KEY', 'env.ANTHROPIC_MODEL']);
    const pinned = readSettings(sandbox);
    assert.equal((pinned.env as Record<string, unknown>).ANTHROPIC_MODEL, SECOND_MODEL);
    assert.equal((pinned.env as Record<string, unknown>).MY_OWN_VAR, 'keep-me');
    // Claude Code's own top-level `model` is a different setting with a different
    // meaning, so pinning ours must not read as permission to rewrite theirs.
    assert.equal(pinned.model, 'opusplan', 'the user’s own model setting is preserved');

    // The account went back to the provider default. Leaving the variable behind
    // would keep an unchosen model in force, so the one we added is withdrawn.
    const second: ApplyResult = claudeCode.applyPermanent(router, TEST_KEY, {
      ...options,
      previous: activationFrom(router, first, undefined, SECOND_MODEL),
    });
    assert.deepEqual(second.managedKeys, ['env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_API_KEY']);
    const after = readSettings(sandbox);
    assert.equal('ANTHROPIC_MODEL' in (after.env as Record<string, unknown>), false);
    assert.equal((after.env as Record<string, unknown>).ANTHROPIC_BASE_URL, 'https://api.gorouter.example');
    assert.equal(after.model, 'opusplan', 'still not ours to touch');
  });
});

test('config.json remembers the model and never a credential', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedRouter(service);
    service.setAccountModel(seeded.id, nth(seeded, 0).id, FIRST_MODEL);

    const raw = readFileSync(paths().configFile, 'utf8');
    assert.match(raw, /GPT-5\.6/, 'a model name is not a secret, so it lives beside the profile');
    for (const secret of [TEST_KEY, SECOND_KEY, THIRD_KEY]) {
      assert.equal(raw.includes(secret), false, 'and no key is ever written next to it');
    }
  });
});

// ── The keyboard ──────────────────────────────────────────────────────────────
//
// From here on everything runs on the virtual terminal, because the requirement is
// a claim about what the user sees and about who owns stdin.

/** A marker only the account screen draws, so "is it underneath?" is answerable. */
const ACCOUNTS = 'ACCOUNTS BODY';

/**
 * An `AppContext` with only the field the picker reads.
 *
 * `chooseModel` touches `ctx.service` and nothing else — no flags, no provider, no
 * credential backend — so building those would add scaffolding no assertion looks
 * at, and would quietly imply the picker can reach a key.
 */
function pickerContext(service: RouterService): AppContext {
  return { service } as unknown as AppContext;
}

/**
 * The dashboard's account screen, reduced to the one key this feature adds.
 *
 * `M` opens the real picker through `withInlineView`, exactly as `onAccountKey`
 * does, and the cancel handling is the dashboard's: a cancelled view is a status
 * line, not an error.
 */
function openAccountScreen(service: RouterService, routerId: string, accountId: string): Promise<number | undefined> {
  let status: string | undefined;
  return runScreen<number>({
    render: () => ['', `  ${ACCOUNTS}`, `  ${status ?? 'nothing has happened yet'}`],
    onKey: (key) => {
      if (isShortcut(key, 'm')) {
        return withInlineView(async (): Promise<undefined> => {
          const router = service.resolve(routerId);
          try {
            const result = await chooseModel(pickerContext(service), router, service.resolveAccount(router, accountId));
            if (result.changed) status = result.status;
          } catch (error) {
            if (!isCancelled(error)) throw error;
            status = 'Cancelled. Nothing was changed.';
          }
          return undefined;
        });
      }
      if (isShortcut(key, 'q')) return { done: true, value: 0 };
      return undefined;
    },
  });
}

test('the action screen reads M as Change Model, and Enter still continues with what is on it', async () => {
  await withFakeTerminal(async (vt) => {
    const askMode = (): Promise<string> =>
      select<string>({
        message: 'What now?',
        options: [
          { label: 'Temporary', value: 'temporary' },
          { label: 'Permanent', value: 'permanent' },
          { label: 'Back', value: 'cancel', shortcut: 'b' },
        ],
        details: [`  Current model  ${FIRST_MODEL}`],
        help: 'Enter continue   M change model   Esc cancel',
        hotkeys: [{ key: 'm', value: 'model', label: 'Change Model' }],
      });

    // Either case of the letter, and the screen says what it would continue with
    // rather than asking again.
    for (const stroke of ['m', 'M']) {
      const pending = askMode();
      await settle();
      assert.equal(vt.count(`Current model  ${FIRST_MODEL}`), 1);
      assert.equal(vt.count('Which model?'), 0, 'no model screen has been opened yet');
      press(stroke);
      assert.equal(await pending, 'model', `${stroke} is the Change Model shortcut`);
    }

    // The point of the feature: the remembered model is already the answer, so
    // Enter goes straight on to Temporary/Permanent.
    const pending = askMode();
    await settle();
    press('\r');
    assert.equal(await pending, 'temporary', 'Enter continues with the row it is on');
  });
});

test('a name field treats M as the letter M, and a key field never echoes what was typed', async () => {
  await withFakeTerminal(async (vt) => {
    const named = text({ message: 'Account name' });
    await settle();
    press('MyModelAccount');
    await settle();
    assert.equal(vt.count('SELECT MODEL'), 0, 'typing a name must not open a picker');
    press('\r');
    assert.equal(await named, 'MyModelAccount', 'every M reached the editor as a character');

    // The same guarantee where it matters most: a pasted key is text, and it is
    // masked while it is typed and masked in the line left behind.
    const secret = password({ message: 'API key' });
    await settle();
    press(SECOND_KEY);
    await settle();
    assert.equal(vt.text.includes(SECOND_KEY), false, 'input is hidden');
    press('\r');
    assert.equal(await secret, SECOND_KEY, 'and captured in full all the same');
    assert.equal(vt.text.includes(SECOND_KEY), false, 'the summary shows a mask, never the key');
  });
});

test('M opens the picker over the account screen, and what it changes is remembered', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedRouter(service);
    const account = nth(seeded, 0);
    for (const model of [FIRST_MODEL, SECOND_MODEL, THIRD_MODEL]) service.addModel(seeded.id, model);
    service.setAccountModel(seeded.id, account.id, FIRST_MODEL);

    await withFakeTerminal(async (vt) => {
      const base = readers();
      const done = openAccountScreen(service, seeded.id, account.id);
      await settle();
      assert.equal(vt.count(ACCOUNTS), 1);
      assert.equal(readers(), base + 1, 'the account screen is reading keys');

      press('m');
      await settle();
      assert.equal(vt.count('SELECT MODEL'), 1, 'the picker is up');
      assert.equal(vt.count(ACCOUNTS), 0, 'over the screen it was opened from, not beside it');
      assert.match(vt.text, /Current\s+GPT-5\.6/, 'and it names what is remembered right now');
      assert.equal(readers(), base + 1, 'on the screen’s own reader, not a second one');

      // Down, Enter: changing a model is a keypress and an Enter, not a walk.
      press(`${ESC}[B`);
      await settle();
      press('\r');
      await settle();

      assert.equal(vt.count('SELECT MODEL'), 0, 'the picker is unmounted, not scrolled away');
      assert.equal(vt.count(ACCOUNTS), 1, 'and the account screen comes back exactly once');
      assert.equal(vt.count(`Model: ${SECOND_MODEL}`), 1, 'which reports what changed');
      assert.equal(modelOnDisk(service, seeded.id, account.id), SECOND_MODEL, 'the selection is on disk');
      assert.equal(modelOnDisk(service, seeded.id, nth(seeded, 1).id), undefined, 'a sibling is untouched');
      assert.equal(vt.enters, 1, 'the picker draws inside the screen’s buffer rather than opening another');
      assert.equal(readers(), base + 1);

      press('q');
      await settle();
      assert.equal(await done, 0);
      assert.equal(readers(), base, 'nothing is left listening when the screen is gone');
      assert.equal(vt.normalText, SHELL_LINE, 'the scrollback is byte-for-byte as the shell left it');
    });
  });
});

test('Back and Esc leave the remembered model exactly as it was, however often the picker is opened', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const seeded = await seedRouter(service);
    const account = nth(seeded, 0);
    service.addModel(seeded.id, FIRST_MODEL);
    service.addModel(seeded.id, SECOND_MODEL);
    service.setAccountModel(seeded.id, account.id, FIRST_MODEL);

    await withFakeTerminal(async (vt) => {
      const base = readers();
      const done = openAccountScreen(service, seeded.id, account.id);
      await settle();

      // M → B → M → Esc → M → B. Not choosing is a legitimate answer, and it has
      // to be an answer the screen can be left by three times running.
      for (const [round, leave] of [
        [1, 'b'],
        [2, ESC],
        [3, 'b'],
      ] as const) {
        press('m');
        await settle();
        assert.equal(vt.count('SELECT MODEL'), 1, `round ${round}: one picker, not ${round}`);
        assert.equal(vt.count(ACCOUNTS), 0, `round ${round}: the account screen is not left underneath`);

        press(leave);
        await settle();
        assert.equal(vt.count('SELECT MODEL'), 0, `round ${round}: the picker is replaced, not scrolled away`);
        assert.equal(vt.count(ACCOUNTS), 1, `round ${round}: the account screen comes back exactly once`);
        assert.equal(modelOnDisk(service, seeded.id, account.id), FIRST_MODEL, `round ${round}: nothing was chosen`);
        assert.equal(readers(), base + 1, `round ${round}: one reader throughout`);
      }

      assert.equal(vt.enters, 1, 'one buffer switch for the whole session, not one per picker');
      assert.equal(vt.exits, 0);

      press('q');
      await settle();
      assert.equal(await done, 0);
      assert.equal(vt.isAlternate, false, 'and the real screen is handed back on exit');
      assert.equal(vt.exits, 1, 'one entry, one exit — the terminal is restored exactly once');
      assert.equal(readers(), base);
      assert.equal(vt.normalText, SHELL_LINE);
    });
  });
});

test('a first-time account adds and selects its first model in one pass', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const created = await service.add({ name: 'GoRouter', baseUrl: 'api.gorouter.example', apiKey: TEST_KEY });
    const account = nth(created, 0);

    await withFakeTerminal(async (vt) => {
      const base = readers();
      const done = openAccountScreen(service, created.id, account.id);
      await settle();

      press('m');
      await settle();
      assert.equal(vt.count('SELECT MODEL'), 1);
      assert.match(vt.text, /No models yet/, 'an empty list asks instead of assuming');
      assert.match(vt.text, /no model selected/, 'and says plainly that nothing is pinned');
      assert.equal(/Provider default/.test(vt.text), false, 'there is nothing to fall back from yet');

      // Enter on `Add a model…`, then the name — whose leading M is a letter,
      // because a text field owns every printable key it is given.
      press('\r');
      await settle();
      press('MyModel 4.8');
      await settle();
      assert.equal(vt.count('SELECT MODEL'), 1, 'the form replaced the list inside the same view');
      assert.equal(readers(), base + 1, 'a form inside the picker is still one reader');
      press('\r');
      await settle();

      assert.equal(vt.count(ACCOUNTS), 1, 'the account screen is back, one pass later');
      assert.equal(modelOnDisk(service, created.id, account.id), 'MyModel 4.8', 'naming it selected it');
      assert.deepEqual([...service.resolve(created.id).models], ['MyModel 4.8'], 'and offered it to the router');
      assert.equal(vt.count('Model: MyModel 4.8'), 1);

      press('q');
      await settle();
      assert.equal(await done, 0);
      assert.equal(readers(), base);
      assert.equal(vt.normalText, SHELL_LINE);
    });
  });
});
