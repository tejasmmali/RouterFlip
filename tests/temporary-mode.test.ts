/**
 * Temporary-mode regression net (the child environment, end to end).
 *
 * Complements tests/launcher.test.ts, which already covers: (1) ANTHROPIC_BASE_URL
 * applied, (2) API key applied, (5) stale ANTHROPIC_AUTH_TOKEN dropped, (6)
 * process.env untouched, (9) Windows .cmd via the interpreter, (10) args forwarded,
 * (11) exit code verbatim, (12/13) stdin released while the child runs and reclaimed
 * after (the SIGINT / handler-removal tests). This file adds the rest.
 *
 * No real process is ever spawned and no real key is used: the fake credential
 * below never reaches a log, an argument, or test output — only the child's own
 * environment block, which is exactly where it is supposed to be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { launchRouter } from '../src/services/launcher.ts';
import { claudeCode } from '../src/providers/claude-code.ts';
import { fakeSpawn, makeRouter, withSandbox, sandboxService } from './helpers.ts';

// Fake credentials — never the real thing, never printed.
const KEY_A = 'TEST_SECRET_VALUE_A';
const KEY_B = 'TEST_SECRET_VALUE_B';
const KEY_C = 'TEST_SECRET_VALUE_C';
const TOKEN = 'TEST_SECRET_VALUE_TOKEN';

async function childEnvOf(options: Parameters<typeof launchRouter>[0]): Promise<NodeJS.ProcessEnv> {
  const spawner = fakeSpawn();
  const pending = launchRouter({ ...options, executable: '/usr/local/bin/claude', spawnFn: spawner.spawnFn });
  spawner.child().emit('close', 0, null);
  await pending;
  return spawner.calls[0]?.options.env as NodeJS.ProcessEnv;
}

// (3) an auth-token router puts the token in ANTHROPIC_AUTH_TOKEN.
test('temporary mode applies ANTHROPIC_AUTH_TOKEN when the router uses it', async () => {
  const env = await childEnvOf({
    router: makeRouter({ authEnvVar: 'ANTHROPIC_AUTH_TOKEN' }),
    apiKey: TOKEN,
    provider: claudeCode,
    baseEnv: { PATH: '/usr/bin' },
  });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, TOKEN);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

// (4) switching to a token strips a stale ANTHROPIC_API_KEY from the shell.
test('temporary mode removes a stale ANTHROPIC_API_KEY when using an auth token', async () => {
  const env = await childEnvOf({
    router: makeRouter({ authEnvVar: 'ANTHROPIC_AUTH_TOKEN' }),
    apiKey: TOKEN,
    provider: claudeCode,
    baseEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'stale-key' },
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'a stale key must not outrank the router token');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, TOKEN);
});

// (7) a temporary launch writes nothing to Claude Code's settings file.
test('temporary mode does not create or modify the Claude Code settings file', async () => {
  await withSandbox(async (sandbox) => {
    assert.equal(existsSync(sandbox.settingsFile), false, 'sandbox starts with no settings file');
    await childEnvOf({ router: makeRouter({ baseUrl: 'https://gate.example' }), apiKey: KEY_A, provider: claudeCode });
    assert.equal(existsSync(sandbox.settingsFile), false, 'a temporary launch must leave settings.json untouched');
  });
});

// (8) the credential that reaches the child is the *selected* account's, not
// another account's — through the real service and credential store.
test('temporary mode launches with the selected account credential (Account 2, not 1 or 3)', async () => {
  await withSandbox(async () => {
    const { service } = sandboxService();
    const router = await service.add({ name: 'Multi', baseUrl: 'https://multi.example', apiKey: KEY_A });
    const account2 = await service.addAccount(router.id, { name: 'Account 2', apiKey: KEY_B });
    await service.addAccount(router.id, { name: 'Account 3', apiKey: KEY_C });
    const current = service.resolve(router.id);

    const apiKey = await service.apiKey(current, service.findAccount(current, account2.id));
    const env = await childEnvOf({ router: current, apiKey, provider: claudeCode });

    assert.equal(env.ANTHROPIC_API_KEY, KEY_B);
    assert.notEqual(env.ANTHROPIC_API_KEY, KEY_A);
    assert.notEqual(env.ANTHROPIC_API_KEY, KEY_C);
  });
});

// (14) the key is never placed on the command line or in the spawned arguments —
// it lives only in the environment block. (Log scrubbing is exercised where
// logger.protect is registered; here we prove the arg vector is clean.)
test('the API key never appears in the spawned command or arguments', async () => {
  const spawner = fakeSpawn();
  const pending = launchRouter({
    router: makeRouter(),
    apiKey: KEY_A,
    provider: claudeCode,
    executable: '/usr/local/bin/claude',
    spawnFn: spawner.spawnFn,
    args: ['--resume', 'session-1'],
  });
  spawner.child().emit('close', 0, null);
  await pending;

  const call = spawner.calls[0];
  assert.ok(call);
  assert.equal(call.command.includes(KEY_A), false, 'the key must not be in the command');
  assert.equal(call.args.some((arg) => arg.includes(KEY_A)), false, 'the key must not be in any argument');
  assert.equal((call.options.env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY, KEY_A, 'it belongs in the env block only');
});

// The regression the mocked-env tests missed: Claude Code >= 2.0.1 applies the
// `env` block of settings.json *over* the inherited process environment, so a
// permanent gateway there beats anything temporary mode puts in the child env.
// Temporary mode must therefore also hand the child a higher-precedence
// `--settings` file — and that file must carry the router's gateway, the router's
// auth variable, and a *blanked* competing auth variable so a permanent value
// cannot shadow it. The file must exist while the child runs and be gone after.
test('temporary mode overrides a permanent settings.json via a --settings file, then cleans it up', async () => {
  const spawner = fakeSpawn();
  const pending = launchRouter({
    router: makeRouter({ baseUrl: 'https://agent.example', authEnvVar: 'ANTHROPIC_AUTH_TOKEN' }),
    apiKey: 'TEST_SECRET_VALUE_TOKEN',
    provider: claudeCode,
    executable: '/usr/local/bin/claude',
    spawnFn: spawner.spawnFn,
    model: 'Agent-Model-X',
    args: ['-p', 'hi'],
  });

  // While the child is alive the override file must be present and complete.
  const call = spawner.calls[0];
  assert.ok(call);
  assert.equal(call.args[0], '--settings');
  const settingsFile = String(call.args[1]);
  assert.deepEqual(call.args.slice(2), ['-p', 'hi'], 'the user arguments follow, unchanged');
  assert.ok(existsSync(settingsFile), 'the override file exists while the child runs');
  const written = JSON.parse(readFileSync(settingsFile, 'utf8')) as { env: Record<string, string> };
  assert.equal(written.env.ANTHROPIC_BASE_URL, 'https://agent.example', 'the router gateway wins');
  assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, 'TEST_SECRET_VALUE_TOKEN', 'the selected auth variable');
  assert.equal(written.env.ANTHROPIC_API_KEY, '', 'the competing auth var is blanked so a permanent value cannot shadow it');
  assert.equal(written.env.ANTHROPIC_MODEL, 'Agent-Model-X', 'the selected model reaches the child');

  spawner.child().emit('close', 0, null);
  await pending;
  assert.equal(existsSync(settingsFile), false, 'the override file is deleted once the child exits');
});

