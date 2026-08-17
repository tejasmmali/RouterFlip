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

/**
 * Blanks the frame and parks the cursor at the top of it.
 *
 * `2J` on its own leaves the cursor where it was in some terminals and moves it in
 * others, so it is always followed by an absolute home — the one form that behaves
 * identically on Windows Terminal, conhost, macOS Terminal and Linux VTs. Nothing
 * here touches the scrollback: `3J` would, and is deliberately never used.
 */
const CLEAR_FRAME = `${CLEAR_SCREEN}${CURSOR_HOME}`;

/**
 * The one renderer that owns the terminal.
 *
 * A single slot rather than a stack, on purpose: two renderers painting the same
 * rows is the failure this module exists to prevent. Every interactive view either
 * *is* this screen or draws inside it via `withInlineView`.
 */
let owner: AltScreen | undefined;

class AltScreen {
  #open = false;
  /** Depth of inline views drawing into the frame; the paint loop yields to them. */
  #inline = 0;

  get isOpen(): boolean {
    return this.#open;
  }

  enter(): void {
    if (this.#open) return;
    this.#open = true;
    process.stdout.write(`${ALT_SCREEN_ENTER}${CURSOR_HIDE}${CLEAR_FRAME}`);
  }

  /**
   * Blanks the frame and shows the cursor so an inline view can draw into it.
   *
   * The alternate buffer is deliberately *not* left here. `?1049l` restores the
   * cursor to wherever it was when the buffer was entered, so a view drawn in the
   * normal buffer left the cursor below its own output — and `?1049h` then saved
   * *that* position, so the next view resumed one frame further down. Successive
   * forms stacked up instead of replacing each other. Staying in the buffer also
   * means the user's real scrollback is never written to at all.
   */
  beginInline(): void {
    this.#inline += 1;
    if (!this.#open || this.#inline > 1) return;
    process.stdout.write(`${CLEAR_FRAME}${CURSOR_SHOW}`);
  }

  /** Blanks the finished view, leaving an empty frame for the next paint. */
  endInline(): void {
    if (this.#inline > 0) this.#inline -= 1;
    if (!this.#open || this.#inline > 0) return;
    process.stdout.write(`${CURSOR_HIDE}${CLEAR_FRAME}`);
  }

  paint(rows: readonly string[], view: Viewport): void {
    // An inline view owns the frame while it is up: a resize arriving mid-form
    // must not repaint the dashboard over the top of it.
    if (!this.#open || this.#inline > 0) return;
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
 * How many rows a view drawing into the frame may use, or `undefined` when no
 * full-screen frame is open.
 *
 * A page has a bottom only inside the frame: typed straight into a shell, a
 * prompt scrolls with everything else and padding it to the terminal height
 * would leave a hole. `paint` covers rows 1..height-1 and leaves the last row
 * clear, so an inline view gets exactly the same rows the dashboard uses — which
 * is what puts its key bar on the same line as the dashboard's.
 */
export function frameRows(): number | undefined {
  return owner?.isOpen === true ? viewport().height - 1 : undefined;
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
  const previousOwner = owner;
  owner = screen;

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
      // The order matters: stop reading keys, then restore the terminal, then let
      // the caller print into a screen nothing else is drawing on.
      session.close();
      screen.leave();
      owner = previousOwner;
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
 * Runs `body` inside the current frame, blanked before it draws and blanked again
 * when it is done.
 *
 * This is how the dashboard shows a form, a report or an error: one view at a time,
 * replacing what was on screen rather than being appended below it. The frame is
 * cleared on the way out too, so the dashboard's next paint — which only covers
 * rows 1..height-1 — cannot leave a stray row of the form behind.
 *
 * With no screen open (`routerflip add` typed directly) this is a pass-through
 * that writes nothing at all, so the plain commands still scroll normally.
 */
export async function withInlineView<T>(body: () => Promise<T>): Promise<T> {
  const screen = owner;
  screen?.beginInline();
  try {
    return await body();
  } finally {
    screen?.endInline();
  }
}

/**
 * Hands the whole terminal to a child process, one way.
 *
 * A child — Claude Code — must own the real terminal rather than a buffer
 * RouterFlip is about to discard, because its output has to survive RouterFlip
 * exiting. Launching is always the dashboard's last act, so there is nothing to
 * come back to: after this, painting, blanking and teardown are all no-ops and
 * RouterFlip writes nothing more to the terminal. A no-op when no screen is open,
 * which is what keeps a plain `routerflip claude` byte-for-byte as it was.
 */
export function releaseScreen(): void {
  owner?.leave();
}
