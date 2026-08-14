/**
 * Terminal handover around a child process (spec §5, §16).
 *
 * The bug these tests exist for: with `stdio: 'inherit'` the parent and the child
 * share file descriptor 0, so anything the parent still has attached to stdin
 * competes with the child for the same input queue. Bytes are then split between
 * two readers, and a multi-byte escape sequence loses its `ESC [` prefix to one of
 * them while the tail arrives at the other — which is how a focus report or a
 * mouse report gets printed as literal text inside Claude Code's prompt.
 *
 * No real process is spawned and no real terminal is needed: stdin and stdout are
 * given TTY-shaped stubs for the duration of each test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch } from '../src/services/launcher.ts';
import { openInput, releaseStdin } from '../src/ui/input.ts';
import { fakeSpawn } from './helpers.ts';

interface StdinStub {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (raw: boolean) => void;
}

/**
 * Runs `body` with stdin and stdout pretending to be a terminal, restoring both
 * afterwards. `setRawMode` records into `isRaw` exactly as Node's tty.ReadStream
 * does, so the assertions can read the mode back.
 */
async function withFakeTty(body: () => Promise<void>): Promise<void> {
  const stdin = process.stdin as unknown as StdinStub;
  const stdout = process.stdout as unknown as { isTTY?: boolean };
  const saved = { isTTY: stdin.isTTY, isRaw: stdin.isRaw, setRawMode: stdin.setRawMode, out: stdout.isTTY };

  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (raw: boolean): void => {
    stdin.isRaw = raw;
  };
  stdout.isTTY = true;
  try {
    await body();
  } finally {
    process.stdin.pause();
    stdin.isTTY = saved.isTTY;
    stdin.isRaw = saved.isRaw;
    stdin.setRawMode = saved.setRawMode;
    stdout.isTTY = saved.out;
  }
}

/** How many `data` listeners the parent has on stdin right now. */
function readers(): number {
  return process.stdin.listenerCount('data');
}

test('a launch with no open session never touches stdin', async () => {
  const before = readers();
  const spawner = fakeSpawn();
  const pending = launch({ executable: 'claude', args: [], env: {} }, spawner.spawnFn);
  assert.equal(readers(), before, '`routerflip claude` must leave the descriptor as the shell set it');
  spawner.child().emit('close', 0, null);
  await pending;
  assert.equal(readers(), before);
});

test('releaseStdin is a no-op when nothing is reading', () => {
  const before = readers();
  const restore = releaseStdin();
  assert.equal(readers(), before);
  restore();
  restore(); // idempotent
  assert.equal(readers(), before);
});

test('the dashboard stops reading stdin while the child owns the terminal', async () => {
  await withFakeTty(async () => {
    const stdin = process.stdin as unknown as StdinStub;
    const session = openInput(() => {});
    assert.equal(readers(), 1, 'the dashboard is reading keys');
    assert.equal(stdin.isRaw, true);

    const spawner = fakeSpawn();
    const pending = launch({ executable: 'claude', args: [], env: {} }, spawner.spawnFn);

    assert.equal(readers(), 0, 'nothing in the parent may compete for fd 0 while Claude Code runs');
    assert.equal(stdin.isRaw, false, 'and the child gets a cooked descriptor to set up as it likes');

    spawner.child().emit('close', 0, null);
    await pending;

    assert.equal(readers(), 1, 'the dashboard gets the keyboard back');
    assert.equal(stdin.isRaw, true);

    session.close();
    assert.equal(readers(), 0, 'and releases it for good on close');
    assert.equal(stdin.isRaw, false, 'the terminal is left in the mode it was found in');
  });
});

test('a failed spawn hands the keyboard back too', async () => {
  await withFakeTty(async () => {
    const stdin = process.stdin as unknown as StdinStub;
    const session = openInput(() => {});
    const spawner = fakeSpawn();
    const pending = launch({ executable: 'claude', args: [], env: {} }, spawner.spawnFn);
    spawner.child().emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    await assert.rejects(pending);

    assert.equal(readers(), 1, 'an error must not leave the dashboard deaf');
    assert.equal(stdin.isRaw, true);
    session.close();
  });
});

test('Ctrl+C during a launch neither kills the child nor the parent', async () => {
  await withFakeTty(async () => {
    const session = openInput(() => {});
    const spawner = fakeSpawn();
    const pending = launch({ executable: 'claude', args: [], env: {} }, spawner.spawnFn);

    process.emit('SIGINT');
    assert.deepEqual(spawner.child().killed, [], 'the terminal already delivered it to the child');

    spawner.child().emit('close', 0, null);
    await pending;
    session.close();
  });
});
