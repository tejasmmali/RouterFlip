/**
 * Frame lifecycle: one view on screen at a time (spec §1, §18).
 *
 * The bug these tests exist for: an inline view — `Add a router`, `Edit` — used to
 * *leave* the alternate buffer and draw on the normal screen. `?1049l` restores the
 * cursor that `?1049h` saved, the form then advanced that cursor by a screenful, and
 * the `?1049h` on the way back saved the advanced position — so the next view
 * resumed one frame lower and the forms accumulated:
 *
 *     RouterFlip / Add a router / …
 *     RouterFlip / Add a router / …
 *
 * Counting escape sequences in captured output would not catch that, so everything
 * RouterFlip writes is applied to a small virtual terminal and the assertions ask
 * the only question that matters: what is on the screen right now?
 *
 * No real terminal is needed — stdin, stdout and stderr are given TTY-shaped stubs
 * for the duration of each test — and no router, key or network is involved: the
 * views here print what the real ones print, which is all the frame lifecycle sees.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ESC } from '../src/ui/ansi.ts';
import { openInput, type InputSession } from '../src/ui/input.ts';
import { isShortcut } from '../src/ui/keys.ts';
import { blank, heading, line } from '../src/ui/output.ts';
import { releaseScreen, runScreen, withInlineView, type ScreenOutcome } from '../src/ui/screen.ts';
import { createTheme, setTheme, theme } from '../src/ui/theme.ts';
import { bannerLines } from '../src/ui/views.ts';
import { Vt } from './vt.ts';

/** What the shell left on screen before RouterFlip started. */
const SHELL_LINE = 'PS C:\\> routerflip';
/** A marker only the dashboard draws, so "is it underneath?" is answerable. */
const DASHBOARD = 'DASHBOARD BODY';
/** The same, for the account screen the dashboard opens on Enter. */
const ACCOUNTS = 'ACCOUNTS BODY';

type Restore = () => void;

/** Replaces one property and gives back the exact undo, own-ness included. */
function stub(target: object, key: string, value: unknown): Restore {
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
async function withFakeTerminal(body: (vt: Vt) => Promise<void>): Promise<void> {
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
async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function press(sequence: string): void {
  process.stdin.emit('data', sequence);
}

/** How many readers the parent has on stdin right now. */
function readers(): number {
  return process.stdin.listenerCount('data');
}

/**
 * The dashboard's `pressAnyKey`: a session opened on top of the screen's own, which
 * is what keeps a single reader however deep the views nest.
 */
function waitForKey(): Promise<void> {
  return new Promise<void>((resolve) => {
    let session: InputSession | undefined;
    session = openInput(() => {
      session?.close();
      resolve();
    });
  });
}

/**
 * Prints what `addInteractive` and `editInteractive` print — a banner, a heading and
 * a form — then waits, exactly as the real ones do.
 */
async function inlineView(label: string): Promise<void> {
  for (const row of bannerLines(80)) line(row);
  blank();
  heading(`  ${label}`);
  blank();
  line('  Name');
  line('  Base URL');
  await waitForKey();
}

/** The dashboard, reduced to the navigation the bug report describes. */
function openDashboard(): Promise<number | undefined> {
  return runScreen<number>({
    render: () => ['', `  ${DASHBOARD}`],
    onKey: (key) => {
      if (key.char === 'a') return withInlineView(() => inlineView('Add a router')).then(() => undefined);
      if (key.char === 'e') return withInlineView(() => inlineView('Edit router')).then(() => undefined);
      if (key.char === 'q') return { done: true, value: 0 };
      return undefined;
    },
  });
}

test('reopening Add a router replaces the previous frame rather than stacking it', async () => {
  await withFakeTerminal(async (vt) => {
    const done = openDashboard();
    await settle();
    assert.equal(vt.isAlternate, true, 'the dashboard owns the alternate buffer');
    assert.equal(vt.count(DASHBOARD), 1);

    // routerflip → Add Router → Back → Add Router → Back → Add Router.
    for (let round = 1; round <= 3; round += 1) {
      press('a');
      await settle();
      assert.equal(vt.count('Add a router'), 1, `round ${round}: one form, not ${round}`);
      assert.equal(vt.count('RouterFlip'), 1, `round ${round}: one banner, not ${round}`);
      assert.equal(vt.count(DASHBOARD), 0, `round ${round}: the dashboard is not left underneath`);

      press(' ');
      await settle();
      assert.equal(vt.count('Add a router'), 0, `round ${round}: the form is unmounted, not scrolled away`);
      assert.equal(vt.count(DASHBOARD), 1, `round ${round}: the dashboard comes back exactly once`);
    }

    assert.equal(vt.enters, 1, 'one buffer switch for the whole session, not one per view');
    assert.equal(vt.exits, 0);

    press('q');
    await settle();
    assert.equal(await done, 0);
    assert.equal(vt.isAlternate, false, 'and the real screen is handed back on exit');
    assert.equal(vt.exits, 1);
    assert.equal(vt.normalText, SHELL_LINE, 'the scrollback is byte-for-byte as the shell left it');
  });
});

test('dashboard → add → dashboard → edit → dashboard leaves no duplicate frames', async () => {
  await withFakeTerminal(async (vt) => {
    const done = openDashboard();
    await settle();

    press('a');
    await settle();
    assert.equal(vt.count('Add a router'), 1);
    assert.equal(vt.count('Edit router'), 0);

    press(' ');
    await settle();
    assert.equal(vt.count(DASHBOARD), 1);
    assert.equal(vt.count('Add a router'), 0);

    press('e');
    await settle();
    assert.equal(vt.count('Edit router'), 1);
    assert.equal(vt.count('Add a router'), 0, 'the form before it is gone, not scrolled above it');
    assert.equal(vt.count(DASHBOARD), 0);

    press(' ');
    await settle();
    assert.equal(vt.count(DASHBOARD), 1);
    assert.equal(vt.count('Edit router'), 0);
    assert.equal(vt.count('RouterFlip'), 0, 'nothing of either view survives on the dashboard');

    press('q');
    await settle();
    assert.equal(await done, 0);
    assert.equal(vt.normalText, SHELL_LINE);
  });
});

test('a resize while a view is open does not paint the dashboard over it', async () => {
  await withFakeTerminal(async (vt) => {
    const done = openDashboard();
    await settle();
    press('a');
    await settle();

    process.stdout.emit('resize');
    await settle();

    assert.equal(vt.count('Add a router'), 1, 'the form is still whole');
    assert.equal(vt.count(DASHBOARD), 0, 'one renderer owns the frame at a time');

    press(' ');
    await settle();
    assert.equal(vt.count(DASHBOARD), 1);
    press('q');
    await settle();
    await done;
  });
});

test('nesting views never adds a second reader on stdin', async () => {
  await withFakeTerminal(async (vt) => {
    const base = readers();
    const done = openDashboard();
    await settle();
    assert.equal(readers(), base + 1, 'the dashboard is reading keys');

    press('a');
    await settle();
    assert.equal(readers(), base + 1, 'the view sits on the same reader instead of opening its own');

    press(' ');
    await settle();
    assert.equal(readers(), base + 1, 'and hands the keyboard back to the dashboard');
    assert.equal(vt.count(DASHBOARD), 1);

    press('q');
    await settle();
    await done;
    assert.equal(readers(), base, 'nothing is left listening when the screen is gone');
  });
});

test('handing the terminal to a child process leaves the buffer for good', async () => {
  await withFakeTerminal(async (vt) => {
    const done = runScreen<number>({
      render: () => ['', `  ${DASHBOARD}`],
      onKey: (key) => {
        if (key.char !== 'l') return undefined;
        // What `launch()` does before it spawns: the frame, then the keyboard.
        return withInlineView(async (): Promise<ScreenOutcome<number>> => {
          releaseScreen();
          process.stdout.write('CHILD OUTPUT\n');
          return { done: true, value: 0 };
        });
      },
    });
    await settle();
    press('l');
    await settle();

    assert.equal(await done, 0);
    assert.equal(vt.isAlternate, false, 'Claude Code prints onto the real terminal, not a discarded buffer');
    assert.equal(vt.exits, 1, 'and the teardown afterwards does not switch buffers a second time');
    assert.equal(vt.normalText, `${SHELL_LINE}\nCHILD OUTPUT`, "the child's output survives RouterFlip exiting");
  });
});

test('with no screen open an inline view just scrolls, as a plain command should', async () => {
  await withFakeTerminal(async (vt) => {
    await withInlineView(async () => {
      line('  Add a router');
    });

    assert.equal(vt.enters, 0, 'no buffer switch, no clear-screen — `routerflip add` is unchanged');
    assert.equal(vt.isAlternate, false);
    assert.equal(vt.normalText, `${SHELL_LINE}\n  Add a router`);
  });
});

// ── Accounts navigation ─────────────────────────────────────────────────────
//
// The account screen is a *mode* of the dashboard's single `runScreen`, not a
// second one — `dashboardCommand` switches `Mode` and re-renders. That is a frame
// lifecycle claim, so it belongs here: a nested `runScreen` would enter the
// alternate buffer a second time, and the terminal would then be owed two
// restores instead of one.

/** The dashboard reduced to its two modes and the keys that move between them. */
function openModalDashboard(): Promise<number | undefined> {
  let mode: 'routers' | 'accounts' = 'routers';
  return runScreen<number>({
    render: () => ['', `  ${mode === 'accounts' ? ACCOUNTS : DASHBOARD}`],
    onKey: (key) => {
      if (mode === 'accounts') {
        // `B` and Esc go back rather than quitting, so the user keeps their place.
        if (key.name === 'escape' || isShortcut(key, 'b') || key.name === 'left') {
          mode = 'routers';
          return undefined;
        }
        if (isShortcut(key, 'a')) return withInlineView(() => inlineView('Add an account')).then(() => undefined);
        if (isShortcut(key, 'q')) return { done: true, value: 0 };
        return undefined;
      }
      if (key.name === 'enter' || key.name === 'right') {
        mode = 'accounts';
        return undefined;
      }
      if (isShortcut(key, 'q')) return { done: true, value: 0 };
      return undefined;
    },
  });
}

test('the account screen replaces the router list in the same buffer, and Back restores it', async () => {
  await withFakeTerminal(async (vt) => {
    const done = openModalDashboard();
    await settle();
    assert.equal(vt.count(DASHBOARD), 1);

    // routerflip → Enter → Back → Enter → Esc → Enter → Back.
    for (let round = 1; round <= 3; round += 1) {
      press('\r');
      await settle();
      assert.equal(vt.count(ACCOUNTS), 1, `round ${round}: one account screen, not ${round}`);
      assert.equal(vt.count(DASHBOARD), 0, `round ${round}: the router list is not left underneath`);

      press(round === 2 ? ESC : 'b');
      await settle();
      assert.equal(vt.count(DASHBOARD), 1, `round ${round}: the dashboard comes back exactly once`);
      assert.equal(vt.count(ACCOUNTS), 0, `round ${round}: the account screen is replaced, not scrolled away`);
    }

    assert.equal(vt.enters, 1, 'the account screen is a mode of one screen, not a second alternate buffer');
    assert.equal(vt.exits, 0);

    press('q');
    await settle();
    assert.equal(await done, 0);
    assert.equal(vt.isAlternate, false);
    assert.equal(vt.exits, 1, 'one entry, one exit — the terminal is restored exactly once');
    assert.equal(vt.normalText, SHELL_LINE, 'the scrollback is byte-for-byte as the shell left it');
  });
});

test('adding an account returns to the account screen, on the one reader throughout', async () => {
  await withFakeTerminal(async (vt) => {
    const base = readers();
    const done = openModalDashboard();
    await settle();
    assert.equal(readers(), base + 1, 'the dashboard is reading keys');

    press('\r');
    await settle();
    assert.equal(vt.count(ACCOUNTS), 1);

    press('a');
    await settle();
    assert.equal(vt.count('Add an account'), 1);
    assert.equal(vt.count(ACCOUNTS), 0, 'the form replaces the list it was opened from');
    assert.equal(vt.count(DASHBOARD), 0, 'and the router list is nowhere on screen');
    assert.equal(readers(), base + 1, 'the form sits on the same reader instead of opening its own');

    press(' ');
    await settle();
    assert.equal(vt.count(ACCOUNTS), 1, 'the account screen comes back, not the router list');
    assert.equal(vt.count('Add an account'), 0);
    assert.equal(vt.count('RouterFlip'), 0, 'nothing of the form survives on the account screen');
    assert.equal(vt.count(DASHBOARD), 0);

    press('b');
    await settle();
    assert.equal(vt.count(DASHBOARD), 1, 'and Back still leads to the router list afterwards');
    assert.equal(vt.enters, 1);

    press('q');
    await settle();
    await done;
    assert.equal(readers(), base, 'nothing is left listening when the screen is gone');
    assert.equal(vt.normalText, SHELL_LINE);
  });
});
