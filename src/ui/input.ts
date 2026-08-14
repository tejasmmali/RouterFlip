/**
 * Raw-mode stdin ownership.
 *
 * Exactly one component may *receive* the keyboard at a time, and whoever owns it
 * must hand it back — including when the process dies. `openInput()` centralises
 * the raw-mode toggle, the cursor restore and the SIGINT contract so no prompt
 * can leave the user's terminal in raw mode with a hidden cursor.
 *
 * Sessions form a stack rather than a single slot, because the dashboard legally
 * nests: it suspends its full-screen view and opens an inline prompt on top. Only
 * the topmost session sees keys, so the dashboard cannot act on the keystrokes
 * meant for the prompt it is waiting on.
 */
import { CURSOR_SHOW } from './ansi.ts';
import { decodeKeys, type Key } from './keys.ts';
import { RouterFlipError } from '../errors.ts';

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function requireInteractive(what: string): void {
  if (isInteractive()) return;
  throw new RouterFlipError('NOT_INTERACTIVE', `${what} needs an interactive terminal.`, {
    hint: 'Use the non-interactive form instead, for example `routerflip use <name> --temporary`. Run `routerflip help` for the full list.',
  });
}

export interface InputSession {
  /** Restores cooked mode and the cursor. Safe to call more than once. */
  readonly close: () => void;
}

interface StackEntry {
  readonly onKey: (key: Key) => void;
  readonly close: () => void;
}

const stack: StackEntry[] = [];
let attached = false;
let restoreOnExitInstalled = false;

/** Routes a raw chunk to the session on top of the stack, and only that one. */
function dispatch(chunk: string): void {
  const top = stack[stack.length - 1];
  if (!top) return;
  for (const key of decodeKeys(chunk)) top.onKey(key);
}

function installGlobalRestore(): void {
  if (restoreOnExitInstalled) return;
  restoreOnExitInstalled = true;
  const restoreAll = () => {
    for (const entry of [...stack].reverse()) entry.close();
  };
  process.on('exit', restoreAll);
  // A crash must not leave the terminal unusable.
  process.on('uncaughtException', (error) => {
    restoreAll();
    throw error;
  });
}

/**
 * Takes over stdin and streams decoded keys to `onKey`.
 *
 * Ctrl+C is delivered to `onKey` like any other key so a prompt can cancel
 * cleanly; if the handler does not act on it the caller is expected to exit.
 */
export function openInput(onKey: (key: Key) => void): InputSession {
  requireInteractive('This screen');
  installGlobalRestore();

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    if (stdin.setRawMode) stdin.setRawMode(wasRaw);
    // stdin is only released once nothing is listening: pausing it while an
    // outer session is still live would silently deafen the dashboard.
    if (stack.length === 0) {
      stdin.off('data', dispatch);
      attached = false;
      stdin.pause();
      process.stdout.write(CURSOR_SHOW);
    }
  };

  const entry: StackEntry = { onKey, close };
  stack.push(entry);

  stdin.setEncoding('utf8');
  if (stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  if (!attached) {
    stdin.on('data', dispatch);
    attached = true;
  }

  return { close };
}

const NOTHING_TO_RESTORE = (): void => {};

/**
 * Hands stdin over to a child process, and returns the function that takes it
 * back.
 *
 * With `stdio: 'inherit'` the parent and the child share file descriptor 0. If a
 * session is still attached and flowing while the child runs, both processes read
 * from the same input queue and the bytes are split between them arbitrarily:
 * keystrokes vanish, and a multi-byte escape sequence loses its `ESC [` prefix to
 * one reader while its tail arrives at the other, which is how a focus report or
 * a mouse report ends up printed as literal text in the child's prompt.
 *
 * There is no partial answer here — whoever owns the terminal must own all of it.
 * `process.stdin` is deliberately not touched at all unless a session is open, so
 * a plain `routerflip claude` leaves the descriptor exactly as the shell set it.
 */
export function releaseStdin(): () => void {
  if (!attached && stack.length === 0) return NOTHING_TO_RESTORE;

  const stdin = process.stdin;
  const hadListener = attached;
  const wasRaw = stdin.isRaw ?? false;

  if (hadListener) {
    stdin.off('data', dispatch);
    attached = false;
  }
  if (wasRaw && stdin.setRawMode) stdin.setRawMode(false);
  stdin.pause();

  let restored = false;
  return (): void => {
    if (restored) return;
    restored = true;
    // Only take the keyboard back if something is still waiting for it: after a
    // dashboard launch the screen is torn down instead.
    if (stack.length === 0) return;
    if (wasRaw && stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    if (hadListener && !attached) {
      stdin.on('data', dispatch);
      attached = true;
    }
  };
}
