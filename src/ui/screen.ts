/**
 * Full-screen application runner.
 *
 * The dashboard needs a different discipline from the inline prompts: it takes
 * the whole viewport, so it uses the alternate screen buffer. That single choice
 * is what makes RouterFlip feel like `lazygit` rather than a scrolling menu —
 * and it guarantees the user's scrollback is byte-for-byte intact on exit.
 *
 * Three rules keep the redraw flicker-free and safe:
 *   - draws are wrapped in synchronized-output markers where supported, so the
 *     terminal shows a complete frame instead of a partial repaint;
 *   - every line is truncated to the viewport width, so nothing ever wraps and
 *     row arithmetic stays exact;
 *   - the alternate buffer is exited on resolve, reject, resize failure, crash
 *     and process exit — never conditionally.
 */
import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_EXIT,
  CLEAR_SCREEN,
  CSI,
  CURSOR_HIDE,
  CURSOR_HOME,
  CURSOR_SHOW,
  SYNC_END,
  SYNC_START,
  cursorTo,
} from './ansi.ts';
import { openInput, requireInteractive } from './input.ts';
import { isInterrupt, type Key } from './keys.ts';
import { truncate } from './width.ts';

/** Erase from the cursor to the end of the line. */
const CLEAR_LINE_TAIL = `${CSI}K`;

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface ScreenOutcome<T> {
  readonly done: boolean;
  readonly value?: T;
}

export interface ScreenApp<T> {
  /** Pure function of state → rows. Never longer than `height`. */
  readonly render: (view: Viewport) => readonly string[];
  /**
   * Handles a key. Return `{ done: true, value }` to finish. Returning nothing
   * (or `{ done: false }`) redraws.
   */
  readonly onKey: (key: Key, view: Viewport) => ScreenOutcome<T> | undefined | Promise<ScreenOutcome<T> | undefined>;
  /** Called after the screen is torn down, before the promise settles. */
  readonly onClose?: (value: T | undefined) => void;
}

function viewport(): Viewport {
  return {
    width: Math.max(40, process.stdout.columns ?? 80),
    height: Math.max(10, process.stdout.rows ?? 24),
  };
}

/** True when the terminal advertises synchronized output; harmless if wrong. */
function syncSupported(): boolean {
  return process.env.TERM_PROGRAM !== 'Apple_Terminal';
}

class AltScreen {
  #open = false;

  enter(): void {
    if (this.#open) return;
    this.#open = true;
    process.stdout.write(`${ALT_SCREEN_ENTER}${CURSOR_HIDE}${CLEAR_SCREEN}${CURSOR_HOME}`);
  }

  paint(rows: readonly string[], view: Viewport): void {
    if (!this.#open) return;
    const visible = rows.slice(0, view.height - 1).map((row) => truncate(row, view.width - 1));
    // Repaint every row of the frame, padding the tail, so a shorter frame
    // cannot leave the previous frame's text behind.
    const body: string[] = [];
    for (let index = 0; index < view.height - 1; index += 1) {
      body.push(`${cursorTo(index + 1, 1)}${visible[index] ?? ''}${CLEAR_LINE_TAIL}`);
    }
    const frame = body.join('');
    process.stdout.write(syncSupported() ? `${SYNC_START}${frame}${SYNC_END}` : frame);
  }

  leave(): void {
    if (!this.#open) return;
    this.#open = false;
    process.stdout.write(`${CURSOR_SHOW}${ALT_SCREEN_EXIT}`);
  }
}

/**
 * Runs a full-screen app until it resolves.
 *
 * Ctrl+C resolves with `undefined` rather than killing the process, so the
 * dashboard can exit as cleanly as pressing `q`.
 */
export function runScreen<T>(app: ScreenApp<T>): Promise<T | undefined> {
  requireInteractive('The dashboard');
  const screen = new AltScreen();

  return new Promise<T | undefined>((resolve, reject) => {
    let view = viewport();
    let busy = false;
    let settled = false;

    const paint = () => screen.paint(app.render(view), view);

    const onResize = () => {
      view = viewport();
      paint();
    };

    const finish = (value: T | undefined, error?: unknown) => {
      if (settled) return;
      settled = true;
      process.stdout.off('resize', onResize);
      session.close();
      screen.leave();
      app.onClose?.(value);
      if (error !== undefined) reject(error);
      else resolve(value);
    };

    const session = openInput((key) => {
      if (settled) return;
      if (isInterrupt(key)) {
        finish(undefined);
        return;
      }
      if (busy) return; // ignore input while an async handler is running
      let outcome: ScreenOutcome<T> | undefined | Promise<ScreenOutcome<T> | undefined>;
      try {
        outcome = app.onKey(key, view);
      } catch (error) {
        finish(undefined, error);
        return;
      }
      if (outcome instanceof Promise) {
        busy = true;
        outcome.then(
          (settledOutcome) => {
            busy = false;
            if (settledOutcome?.done) finish(settledOutcome.value);
            else if (!settled) paint();
          },
          (error: unknown) => {
            busy = false;
            finish(undefined, error);
          },
        );
        return;
      }
      if (outcome?.done) finish(outcome.value);
      else paint();
    });

    screen.enter();
    process.stdout.on('resize', onResize);
    paint();
  });
}

/**
 * Runs `body` with the screen suspended, then restores it.
 *
 * Used when the dashboard needs the normal buffer — launching Claude Code, or
 * showing an inline prompt — without losing its place.
 */
export async function withSuspendedScreen<T>(body: () => Promise<T>): Promise<T> {
  process.stdout.write(`${CURSOR_SHOW}${ALT_SCREEN_EXIT}`);
  try {
    return await body();
  } finally {
    process.stdout.write(`${ALT_SCREEN_ENTER}${CURSOR_HIDE}${CLEAR_SCREEN}${CURSOR_HOME}`);
  }
}
