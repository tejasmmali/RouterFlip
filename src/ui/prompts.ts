/**
 * Inline prompts — select, confirm, text, password.
 *
 * These draw *below* the current cursor position and redraw in place, the way
 * `gh` and `pnpm` prompts behave, rather than taking over the whole screen. The
 * full-screen dashboard lives in `screen.ts`.
 *
 * Two invariants keep the redraw arithmetic honest:
 *   - every rendered line is truncated to the terminal width, so nothing wraps
 *     and one logical line is always one physical row;
 *   - after drawing, the rest of the screen is cleared, so a shrinking prompt
 *     never leaves debris behind.
 */
import { CLEAR_LINE, CLEAR_TO_END, CSI, CURSOR_HIDE, CURSOR_SHOW } from './ansi.ts';
import { glyphs } from './icons.ts';
import { openInput, requireInteractive } from './input.ts';
import { isInterrupt, isShortcut, type Key } from './keys.ts';
import { theme } from './theme.ts';
import { displayWidth, terminalWidth, truncate, wrapText } from './width.ts';
import { CancelledError } from '../errors.ts';
import { maskSecretAscii } from '../core/mask.ts';

class Surface {
  #printed = 0;

  draw(lines: readonly string[]): void {
    const width = Math.max(20, (process.stdout.columns ?? 80) - 1);
    const body = lines.map((line) => `${CLEAR_LINE}${truncate(line, width)}`);
    if (this.#printed > 0) process.stdout.write(`${CSI}${this.#printed}A`);
    process.stdout.write(`${body.join('\n')}\n${CLEAR_TO_END}`);
    this.#printed = lines.length;
  }

  /** Leaves `keep` lines on screen and clears the rest. */
  finish(keep: readonly string[]): void {
    const width = Math.max(20, (process.stdout.columns ?? 80) - 1);
    if (this.#printed > 0) process.stdout.write(`${CSI}${this.#printed}A`);
    const body = keep.map((line) => `${CLEAR_LINE}${truncate(line, width)}`);
    process.stdout.write(body.length > 0 ? `${body.join('\n')}\n${CLEAR_TO_END}` : CLEAR_TO_END);
    this.#printed = 0;
  }
}

interface LoopOptions<T> {
  readonly render: () => string[];
  /** Return a result to finish, or undefined to keep looping. */
  readonly onKey: (key: Key) => { done: true; value: T } | { done: false } | undefined;
  /** Lines left on screen after the prompt resolves. */
  readonly summary: (value: T) => string[];
}

function runLoop<T>(options: LoopOptions<T>): Promise<T> {
  requireInteractive('This prompt');
  const surface = new Surface();
  return new Promise<T>((resolve, reject) => {
    process.stdout.write(CURSOR_HIDE);
    const session = openInput((key) => {
      if (isInterrupt(key)) {
        surface.finish([]);
        session.close();
        process.stdout.write(CURSOR_SHOW);
        reject(new CancelledError());
        return;
      }
      let outcome: { done: true; value: T } | { done: false } | undefined;
      try {
        outcome = options.onKey(key);
      } catch (error) {
        surface.finish([]);
        session.close();
        process.stdout.write(CURSOR_SHOW);
        reject(error);
        return;
      }
      if (outcome && outcome.done) {
        surface.finish(options.summary(outcome.value));
        session.close();
        process.stdout.write(CURSOR_SHOW);
        resolve(outcome.value);
        return;
      }
      surface.draw(options.render());
    });
    surface.draw(options.render());
  });
}

// ── select ─────────────────────────────────────────────────────────────────

export interface SelectOption<T> {
  readonly label: string;
  readonly value: T;
  readonly hint?: string;
  /** Extra dimmed line under the label — used for base URLs. */
  readonly detail?: string;
  readonly disabled?: boolean;
  /** Single-key shortcut. */
  readonly shortcut?: string;
}

/**
 * A key that resolves the prompt with a value of its own without occupying a row.
 *
 * This is deliberately a feature of `select` alone. A text prompt gives every
 * printable key to its editor (see `LineEditor.handle`), so a hotkey declared here
 * *cannot* fire while the user is typing a name or pasting a key — the guarantee is
 * structural rather than a condition someone has to remember to write.
 */
export interface SelectHotkey<T> {
  /** Single letter, matched case-insensitively and only without Ctrl/Alt. */
  readonly key: string;
  readonly value: T;
  /** Name for the summary line left behind. Defaults to the key itself. */
  readonly label?: string;
}

export interface SelectPromptOptions<T> {
  readonly message: string;
  readonly options: readonly SelectOption<T>[];
  readonly initial?: number;
  /** Footer hint line. Pass '' to omit. */
  readonly help?: string;
  /** Lines shown between the message and the list, e.g. "Current model: …". */
  readonly details?: readonly string[];
  /** Extra keys that resolve the prompt, shown in `help` rather than as rows. */
  readonly hotkeys?: readonly SelectHotkey<T>[];
}

export async function select<T>(options: SelectPromptOptions<T>): Promise<T> {
  const t = theme();
  const g = glyphs();
  const items = options.options;
  if (items.length === 0) throw new CancelledError('Nothing to choose from.');

  let cursor = Math.max(0, Math.min(options.initial ?? 0, items.length - 1));
  while (items[cursor]?.disabled && cursor < items.length - 1) cursor += 1;

  const move = (delta: number) => {
    for (let step = 0; step < items.length; step += 1) {
      cursor = (cursor + delta + items.length) % items.length;
      if (!items[cursor]?.disabled) return;
    }
  };

  const render = (): string[] => {
    const out = [t.bold(options.message), ''];
    if (options.details && options.details.length > 0) out.push(...options.details, '');
    items.forEach((item, index) => {
      const focused = index === cursor;
      const pointer = focused ? t.accent(g.pointer) : ' ';
      const label = item.disabled ? t.dim(item.label) : focused ? t.selection(item.label) : item.label;
      const hint = item.hint ? ` ${t.dim(item.hint)}` : '';
      out.push(`  ${pointer} ${label}${hint}`);
      if (item.detail) out.push(`      ${t.dim(item.detail)}`);
    });
    const help = options.help ?? `${g.arrowRight} Enter select   Esc cancel`;
    if (help.length > 0) out.push('', `  ${t.dim(help)}`);
    return out;
  };

  return runLoop<T>({
    render,
    onKey: (key) => {
      if (key.name === 'up' || isShortcut(key, 'k')) {
        move(-1);
        return { done: false };
      }
      if (key.name === 'down' || isShortcut(key, 'j')) {
        move(1);
        return { done: false };
      }
      if (key.name === 'home') {
        cursor = 0;
        return { done: false };
      }
      if (key.name === 'end') {
        cursor = items.length - 1;
        return { done: false };
      }
      if (key.name === 'escape') throw new CancelledError();
      if (key.name === 'enter') {
        const item = items[cursor];
        if (!item || item.disabled) return { done: false };
        return { done: true, value: item.value };
      }
      const shortcutIndex = items.findIndex((item) => item.shortcut && isShortcut(key, item.shortcut));
      if (shortcutIndex >= 0) {
        const item = items[shortcutIndex];
        if (item && !item.disabled) return { done: true, value: item.value };
      }
      // Last, so a row's own shortcut always wins over a screen-level hotkey.
      const hotkey = options.hotkeys?.find((entry) => isShortcut(key, entry.key));
      if (hotkey) return { done: true, value: hotkey.value };
      return { done: false };
    },
    summary: (value) => {
      const chosen = items.find((item) => item.value === value);
      if (chosen) return [`${t.muted(options.message)} ${t.accent(chosen.label)}`];
      const hotkey = options.hotkeys?.find((entry) => entry.value === value);
      return [`${t.muted(options.message)} ${t.accent(hotkey?.label ?? hotkey?.key.toUpperCase() ?? '')}`];
    },
  });
}

// ── confirm ────────────────────────────────────────────────────────────────

export interface ConfirmPromptOptions {
  readonly message: string;
  /** Extra lines shown between the question and the buttons. */
  readonly details?: readonly string[];
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly initial?: boolean;
  /** Renders the confirm button in the error colour and defaults to Cancel. */
  readonly danger?: boolean;
}

/** Two-button confirmation, matching the `[ Confirm ] [ Cancel ]` spec layout. */
export async function confirm(options: ConfirmPromptOptions): Promise<boolean> {
  const t = theme();
  const confirmLabel = options.confirmLabel ?? 'Confirm';
  const cancelLabel = options.cancelLabel ?? 'Cancel';
  let yes = options.initial ?? !options.danger;

  const button = (label: string, active: boolean, danger: boolean): string => {
    const text = `[ ${label} ]`;
    if (!active) return t.dim(text);
    return danger ? t.bold(t.error(text)) : t.bold(t.accent(text));
  };

  const render = (): string[] => [
    t.bold(options.message),
    ...(options.details && options.details.length > 0 ? ['', ...options.details] : []),
    '',
    `  ${button(confirmLabel, yes, Boolean(options.danger))}   ${button(cancelLabel, !yes, false)}`,
    '',
    `  ${t.dim(`${glyphs().arrowRight} Tab switch   Enter choose   Esc cancel   (y/n)`)}`,
  ];

  return runLoop<boolean>({
    render,
    onKey: (key) => {
      if (key.name === 'left' || key.name === 'right' || key.name === 'tab' || key.name === 'backtab') {
        yes = !yes;
        return { done: false };
      }
      if (isShortcut(key, 'y')) return { done: true, value: true };
      if (isShortcut(key, 'n')) return { done: true, value: false };
      if (key.name === 'escape') return { done: true, value: false };
      if (key.name === 'enter') return { done: true, value: yes };
      return { done: false };
    },
    summary: (value) => [
      `${t.muted(options.message)} ${value ? t.accent(confirmLabel) : t.dim(cancelLabel)}`,
    ],
  });
}

// ── text / password ────────────────────────────────────────────────────────

/** A tiny single-line editor shared by the text and password prompts. */
class LineEditor {
  value: string;
  cursor: number;

  constructor(initial = '') {
    this.value = initial;
    this.cursor = initial.length;
  }

  /** Applies an editing key. Returns false when the key was not for us. */
  handle(key: Key): boolean {
    if (key.name === 'char' && !key.ctrl && !key.meta) {
      this.value = this.value.slice(0, this.cursor) + key.char + this.value.slice(this.cursor);
      this.cursor += key.char.length;
      return true;
    }
    if (key.name === 'space') {
      this.value = `${this.value.slice(0, this.cursor)} ${this.value.slice(this.cursor)}`;
      this.cursor += 1;
      return true;
    }
    if (key.name === 'backspace') {
      if (this.cursor > 0) {
        this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
        this.cursor -= 1;
      }
      return true;
    }
    if (key.name === 'delete') {
      this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
      return true;
    }
    if (key.name === 'left') {
      this.cursor = Math.max(0, this.cursor - 1);
      return true;
    }
    if (key.name === 'right') {
      this.cursor = Math.min(this.value.length, this.cursor + 1);
      return true;
    }
    if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
      this.cursor = 0;
      return true;
    }
    if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
      this.cursor = this.value.length;
      return true;
    }
    if (key.ctrl && key.name === 'u') {
      this.value = this.value.slice(this.cursor);
      this.cursor = 0;
      return true;
    }
    if (key.ctrl && key.name === 'w') {
      const left = this.value.slice(0, this.cursor).replace(/\s*\S+\s*$/, '');
      this.value = left + this.value.slice(this.cursor);
      this.cursor = left.length;
      return true;
    }
    return false;
  }
}

/** Renders `text` with an inverse-video block at `cursor`. */
function withCursor(text: string, cursor: number): string {
  const t = theme();
  const before = text.slice(0, cursor);
  const at = text.slice(cursor, cursor + 1);
  const after = text.slice(cursor + 1);
  return `${before}${t.inverse(at.length > 0 ? at : ' ')}${after}`;
}

export interface TextPromptOptions {
  readonly message: string;
  readonly initial?: string;
  readonly placeholder?: string;
  /** Return an error message to block submission, or undefined to accept. */
  readonly validate?: (value: string) => string | undefined;
  /** Extra dimmed guidance under the input. */
  readonly help?: string;
  readonly allowEmpty?: boolean;
}

export async function text(options: TextPromptOptions): Promise<string> {
  const t = theme();
  const g = glyphs();
  const editor = new LineEditor(options.initial ?? '');
  let error: string | undefined;

  const render = (): string[] => {
    const shown =
      editor.value.length === 0 && options.placeholder
        ? t.dim(options.placeholder)
        : withCursor(editor.value, editor.cursor);
    const out = [t.bold(options.message), `${t.accent(g.pointer)} ${shown}`];
    if (error) out.push(`  ${t.error(error)}`);
    else if (options.help) out.push(`  ${t.dim(options.help)}`);
    return out;
  };

  return runLoop<string>({
    render,
    onKey: (key) => {
      if (key.name === 'escape') throw new CancelledError();
      if (key.name === 'enter') {
        const value = editor.value.trim();
        if (value.length === 0 && !options.allowEmpty) {
          error = 'This field is required.';
          return { done: false };
        }
        const problem = options.validate?.(value);
        if (problem) {
          error = problem;
          return { done: false };
        }
        return { done: true, value };
      }
      if (editor.handle(key)) {
        error = undefined;
        return { done: false };
      }
      return { done: false };
    },
    summary: (value) => [`${t.muted(options.message)} ${value}`],
  });
}

export interface PasswordPromptOptions {
  readonly message: string;
  /**
   * Mask of the key already stored, if any. When present, submitting an empty
   * value keeps the existing key — the editor never receives the real secret,
   * so an "edit" flow cannot leak it to the screen.
   */
  readonly existingMask?: string;
  readonly validate?: (value: string) => string | undefined;
  readonly help?: string;
}

/** Sentinel meaning "the user chose to keep the key that is already stored". */
export const KEEP_EXISTING = Symbol('keep-existing');
export type PasswordResult = string | typeof KEEP_EXISTING;

export async function password(options: PasswordPromptOptions): Promise<PasswordResult> {
  const t = theme();
  const g = glyphs();
  const editor = new LineEditor('');
  let error: string | undefined;
  let reveal = false;

  const render = (): string[] => {
    const masked = g.maskChar.repeat(editor.value.length);
    const shown =
      editor.value.length === 0
        ? options.existingMask
          ? t.dim(`${options.existingMask}  (press Enter to keep)`)
          : t.dim('paste or type the key')
        : withCursor(reveal ? editor.value : masked, editor.cursor);
    const out = [t.bold(options.message), `${t.accent(g.pointer)} ${shown}`];
    if (error) out.push(`  ${t.error(error)}`);
    else out.push(`  ${t.dim(options.help ?? 'Input is hidden. Ctrl+R reveals it, Ctrl+U clears it.')}`);
    return out;
  };

  return runLoop<PasswordResult>({
    render,
    onKey: (key) => {
      if (key.name === 'escape') throw new CancelledError();
      if (key.ctrl && key.name === 'r') {
        reveal = !reveal;
        return { done: false };
      }
      if (key.name === 'enter') {
        const value = editor.value.trim();
        if (value.length === 0) {
          if (options.existingMask) return { done: true, value: KEEP_EXISTING };
          error = 'An API key is required.';
          return { done: false };
        }
        const problem = options.validate?.(value);
        if (problem) {
          error = problem;
          return { done: false };
        }
        return { done: true, value };
      }
      if (editor.handle(key)) {
        error = undefined;
        return { done: false };
      }
      return { done: false };
    },
    // Never echo the secret — the summary shows a mask of what was captured.
    summary: (value) => [
      `${t.muted(options.message)} ${t.dim(value === KEEP_EXISTING ? (options.existingMask ?? 'unchanged') : maskSecretAscii(value))}`,
    ],
  });
}

/** Convenience wrapper: prints wrapped guidance text above a prompt. */
export function promptIntro(text: string): void {
  const width = terminalWidth();
  for (const line of wrapText(text, width - 2)) process.stdout.write(`${theme().dim(line)}\n`);
}

export { displayWidth };
