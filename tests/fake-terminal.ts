/**
 * A terminal to run interactive tests against.
 *
 * Everything RouterFlip writes is applied to a small virtual terminal (`Vt`), so a
 * test can ask the only question that matters about a frame: what is on the screen
 * right now? Counting escape sequences in captured output cannot answer that.
 *
 * Shared by the frame-lifecycle tests and the keyboard tests, because both need
 * exactly the same thing: a TTY-shaped stdin whose raw mode can be read back, one
 * `Vt` behind both output streams, and a way to press a key and let the paint loop
 * catch up. No real terminal is involved, and every stub is undone afterwards.
 */
import { EventEmitter } from 'node:events';
import { openInput, type InputSession } from '../src/ui/input.ts';
import { createTheme, setTheme, theme } from '../src/ui/theme.ts';
import { Vt } from './vt.ts';

/** What the shell left on screen before RouterFlip started. */
export const SHELL_LINE = 'PS C:\\> routerflip';

export type Restore = () => void;

/** Replaces one property and gives back the exact undo, own-ness included. */
export function stub(target: object, key: string, value: unknown): Restore {
  const owned = Object.prototype.hasOwnProperty.call(target, key);
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
  return () => {
    if (owned && descriptor) Object.defineProperty(target, key, descriptor);
    else delete (target as Record<string, unknown>)[key];
  };
}

/**
 * A stdout/stderr stand-in that records into a `Vt`.
 *
 * The whole stream *object* is swapped rather than its `write` method, because
 * `node --test` reports each result to its parent by writing a serialized event to
 * the real stdout: stubbing the method swallows those, and the run silently loses
 * its own test results. The runner holds the original stream, so it keeps
 * reporting, while anything that reaches for `process.stdout` at call time — which
 * is every writer in `src/ui` — gets this instead.
 */
class FakeTty extends EventEmitter {
  readonly isTTY = true;
  readonly columns: number;
  readonly rows: number;
  readonly #vt: Vt;

  constructor(vt: Vt) {
    super();
    this.#vt = vt;
    this.columns = vt.width;
    this.rows = vt.height;
  }

  write(chunk: unknown): boolean {
    this.#vt.write(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }
}

/**
 * Runs `body` with a virtual terminal in place of the real one.
 *
 * Both streams are routed into the same `Vt`, because they are the same screen for
 * the user: narration goes to stderr and data to stdout, and a frame is only
 * correct if what they jointly leave behind is correct.
 */
export async function withFakeTerminal(body: (vt: Vt) => Promise<void>): Promise<void> {
  const vt = new Vt(100, 30);
  const fake = new FakeTty(vt);
  const raw = process.stdin as unknown as { isRaw?: boolean };
  const savedTheme = theme();
  const restores: Restore[] = [
    stub(process.stdin, 'isTTY', true),
    stub(process.stdin, 'isRaw', false),
    stub(process.stdin, 'setRawMode', (mode: boolean): void => {
      raw.isRaw = mode;
    }),
    stub(process, 'stdout', fake),
    stub(process, 'stderr', fake),
  ];

  setTheme(createTheme('never', { isTTY: false }));
  // Seed the scrollback, so every test can prove RouterFlip never wrote over it.
  vt.write(`${SHELL_LINE}\n`);
  try {
    await body(vt);
  } finally {
    for (const restore of restores.reverse()) restore();
    process.stdin.pause();
    setTheme(savedTheme);
  }
}

/**
 * Lets the paint loop run. Key handling is asynchronous — a view is awaited, then
 * the frame is repainted — so assertions have to wait for the queue to drain.
 */
export async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function press(sequence: string): void {
  process.stdin.emit('data', sequence);
}

/** How many readers the parent has on stdin right now. */
export function readers(): number {
  return process.stdin.listenerCount('data');
}

/**
 * The dashboard's `pressAnyKey`: a session opened on top of the screen's own, which
 * is what keeps a single reader however deep the views nest.
 */
export function waitForKey(): Promise<void> {
  return new Promise<void>((resolve) => {
    let session: InputSession | undefined;
    session = openInput(() => {
      session?.close();
      resolve();
    });
  });
}
