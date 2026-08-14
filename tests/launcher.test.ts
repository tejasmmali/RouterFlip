/**
 * Temporary mode (spec §5, §25: "temporary environment creation", "Claude Code
 * executable missing").
 *
 * The guarantee under test is the one the spec calls extremely important: the
 * router's variables reach the child process and *nothing else changes* — not
 * `process.env`, not any file. No real process is ever spawned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChildEnv, exitCodeFor, launch, launchRouter, spawnPlan } from '../src/services/launcher.ts';
import { claudeCode } from '../src/providers/claude-code.ts';
import { RouterFlipError } from '../src/errors.ts';
import { fakeSpawn, makeRouter, TEST_KEY } from './helpers.ts';

const IS_WINDOWS = process.platform === 'win32';

test('the router variables are added to a copy of the environment', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/dev' };
  const env = buildChildEnv(base, { ANTHROPIC_BASE_URL: 'https://a.example', ANTHROPIC_API_KEY: TEST_KEY });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://a.example');
  assert.equal(env.ANTHROPIC_API_KEY, TEST_KEY);
  assert.equal(env.PATH, '/usr/bin', 'the rest of the environment is carried over');
  assert.deepEqual(base, { PATH: '/usr/bin', HOME: '/home/dev' }, 'the base environment must not be mutated');
});

test('competing variables are removed from the child environment', () => {
  const env = buildChildEnv(
    { ANTHROPIC_AUTH_TOKEN: 'stale-token', ANTHROPIC_API_KEY: 'stale-key' },
    { ANTHROPIC_API_KEY: TEST_KEY },
    ['ANTHROPIC_AUTH_TOKEN'],
  );
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined, 'a stale token must not outrank the router key');
  assert.equal(env.ANTHROPIC_API_KEY, TEST_KEY);
});

test('removal is case-insensitive where the platform is', () => {
  const env = buildChildEnv({ Anthropic_Auth_Token: 'stale' }, { ANTHROPIC_API_KEY: TEST_KEY }, ['ANTHROPIC_AUTH_TOKEN']);
  if (IS_WINDOWS) {
    assert.equal(env.Anthropic_Auth_Token, undefined, 'Windows env names are case-insensitive');
  } else {
    assert.equal(env.Anthropic_Auth_Token, 'stale', 'POSIX names are case-sensitive; only the exact name is dropped');
  }
});

test('launching does not touch this process environment', async () => {
  const router = makeRouter();
  const before = { ...process.env };
  const spawner = fakeSpawn();

  const pending = launchRouter({
    router,
    apiKey: TEST_KEY,
    provider: claudeCode,
    executable: '/usr/local/bin/claude',
    spawnFn: spawner.spawnFn,
    args: ['--resume'],
  });
  spawner.child().emit('close', 0, null);
  await pending;

  assert.deepEqual({ ...process.env }, before, 'process.env must be identical after a temporary launch');
  assert.equal(process.env.ANTHROPIC_BASE_URL, before.ANTHROPIC_BASE_URL);
});

test('the spawned child gets the gateway, the key, and the forwarded arguments', async () => {
  const spawner = fakeSpawn();
  const pending = launchRouter({
    router: makeRouter({ baseUrl: 'https://gate.example' }),
    apiKey: TEST_KEY,
    provider: claudeCode,
    executable: '/usr/local/bin/claude',
    spawnFn: spawner.spawnFn,
    args: ['--resume', 'session-1'],
    baseEnv: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'stale' },
  });
  spawner.child().emit('close', 0, null);
  await pending;

  const call = spawner.calls[0];
  assert.ok(call);
  assert.equal(call.command, '/usr/local/bin/claude');
  assert.deepEqual(call.args, ['--resume', 'session-1']);
  assert.equal(call.options.stdio, 'inherit', 'the child must own the terminal');
  assert.equal(call.options.shell, false, 'no command string is ever built');
  const env = call.options.env as NodeJS.ProcessEnv;
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://gate.example');
  assert.equal(env.ANTHROPIC_API_KEY, TEST_KEY);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('the child exit code is propagated verbatim', async () => {
  const spawner = fakeSpawn();
  const pending = launch({ executable: 'claude', args: [], env: {} }, spawner.spawnFn);
  spawner.child().emit('close', 7, null);
  assert.equal((await pending).code, 7);
});

test('a signalled child reports 128 + signal', () => {
  assert.equal(exitCodeFor(null, 'SIGINT'), 130);
  assert.equal(exitCodeFor(null, 'SIGTERM'), 143);
  assert.equal(exitCodeFor(0, null), 0);
  assert.equal(exitCodeFor(null, null), 1);
});

test('Ctrl+C is left to the child instead of being forwarded', async () => {
  const spawner = fakeSpawn();
  const pending = launch({ executable: 'claude', args: [], env: {} }, spawner.spawnFn);
  // The terminal already delivered this to the child: on POSIX to the whole
  // foreground group, on Windows to every process on the console. Forwarding it
  // again would be a second interrupt — and on Windows a hard TerminateProcess
  // of the `.cmd` wrapper, orphaning Claude Code onto a console the shell is
  // about to start reading.
  process.emit('SIGINT');
  const child = spawner.child();
  assert.deepEqual(child.killed, [], 'RouterFlip must not kill the child on Ctrl+C');
  child.emit('close', null, 'SIGINT');
  assert.equal((await pending).code, 130, 'the child still decides the exit code');
});

test('a signal aimed at RouterFlip alone is forwarded', async () => {
  const spawner = fakeSpawn();
  const pending = launch({ executable: 'claude', args: [], env: {} }, spawner.spawnFn);
  process.emit('SIGTERM');
  const child = spawner.child();
  if (IS_WINDOWS) {
    // There is nothing to forward: kill() is TerminateProcess, and the child may
    // be the cmd.exe shim wrapper rather than Claude Code itself.
    assert.deepEqual(child.killed, []);
  } else {
    assert.deepEqual(child.killed, ['SIGTERM'], 'a `kill` never reached the child, so pass it on');
  }
  child.emit('close', null, 'SIGTERM');
  assert.equal((await pending).code, 143);
});

test('the signal handlers are removed once the child is gone', async () => {
  const before = process.listenerCount('SIGINT');
  const spawner = fakeSpawn();
  const pending = launch({ executable: 'claude', args: [], env: {} }, spawner.spawnFn);
  assert.ok(process.listenerCount('SIGINT') > before, 'the parent survives Ctrl+C while the child runs');
  spawner.child().emit('close', 0, null);
  await pending;
  assert.equal(process.listenerCount('SIGINT'), before, 'and default behaviour is restored afterwards');
});

test('a missing executable produces a friendly error, not ENOENT', async () => {
  const spawner = fakeSpawn();
  const pending = launch({ executable: 'claude', args: [], env: {} }, spawner.spawnFn);
  spawner.child().emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof RouterFlipError);
    assert.equal(error.code, 'LAUNCH_FAILED');
    assert.match(error.message, /was not found/);
    assert.match(error.hint ?? '', /Install Claude Code/);
    return true;
  });
});

test('Claude Code not being installed is explained rather than crashing', async () => {
  await assert.rejects(
    launchRouter({
      router: makeRouter(),
      apiKey: TEST_KEY,
      // A provider that reports "not found" stands in for an uninstalled CLI.
      provider: { ...claudeCode, detect: async () => ({ found: false, hint: 'not installed' }) },
      spawnFn: fakeSpawn().spawnFn,
    }),
    (error: unknown) => error instanceof RouterFlipError && error.code === 'LAUNCH_FAILED' && /not installed/.test(error.hint ?? ''),
  );
});

test('a Windows .cmd shim is run through the interpreter, quoted', () => {
  const plan = spawnPlan('C:\\npm\\claude.cmd', ['-p', 'hello world']);
  if (!IS_WINDOWS) {
    assert.equal(plan.command, 'C:\\npm\\claude.cmd', 'only Windows needs the indirection');
    assert.equal(plan.verbatim, false);
    return;
  }
  // npm installs Claude Code as claude.cmd, which CreateProcess cannot run.
  assert.match(plan.command.toLowerCase(), /cmd\.exe$/);
  assert.equal(plan.verbatim, true);
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(plan.args[3], '""C:\\npm\\claude.cmd" "-p" "hello world""');
});

test('a normal executable is spawned directly', () => {
  const plan = spawnPlan('/usr/local/bin/claude', ['--resume']);
  assert.equal(plan.command, '/usr/local/bin/claude');
  assert.deepEqual(plan.args, ['--resume']);
  assert.equal(plan.verbatim, false);
});

test('the provider builds exactly the two variables it manages', () => {
  const router = makeRouter({ authEnvVar: 'ANTHROPIC_AUTH_TOKEN' });
  assert.deepEqual(claudeCode.envFor(router, TEST_KEY), {
    ANTHROPIC_BASE_URL: router.baseUrl,
    ANTHROPIC_AUTH_TOKEN: TEST_KEY,
  });
  assert.deepEqual(claudeCode.conflicts(router), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(claudeCode.envKeys(router), ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
});
