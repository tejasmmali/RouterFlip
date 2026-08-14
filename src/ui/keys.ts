/**
 * Keyboard input decoding.
 *
 * Node's `readline.emitKeypressEvents` exists, but it pulls in readline's own
 * line editing and behaves inconsistently for Ctrl combinations across Windows
 * conhost / Windows Terminal / xterm. Decoding the byte stream directly is both
 * smaller and more predictable, and it keeps RouterFlip dependency-free.
 */
import { ESC } from './ansi.ts';

export interface Key {
  /** Canonical name: 'up', 'enter', 'escape', 'char', … */
  readonly name: string;
  /** Printable character when `name === 'char'`. */
  readonly char: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly sequence: string;
}

function key(name: string, sequence: string, extra: Partial<Key> = {}): Key {
  return { name, char: '', ctrl: false, shift: false, meta: false, sequence, ...extra };
}

const CSI_NAMES: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'backtab',
};

const TILDE_NAMES: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
};

/**
 * Splits a raw chunk into key events. A chunk can hold several keys (fast typing
 * or a paste), so this returns a list.
 */
export function decodeKeys(chunk: string): Key[] {
  const out: Key[] = [];
  let index = 0;

  while (index < chunk.length) {
    const ch = chunk[index] ?? '';

    // ── Escape-prefixed sequences ──
    if (ch === ESC) {
      const next = chunk[index + 1];

      if (next === '[' || next === 'O') {
        // CSI / SS3: ESC [ <params> <final>
        let cursor = index + 2;
        let params = '';
        while (cursor < chunk.length && /[0-9;]/.test(chunk[cursor] ?? '')) {
          params += chunk[cursor];
          cursor += 1;
        }
        const final = chunk[cursor] ?? '';
        const sequence = chunk.slice(index, cursor + 1);
        const modifier = Number.parseInt(params.split(';')[1] ?? '1', 10) || 1;
        const shift = (modifier - 1) % 2 === 1;
        const ctrl = Math.floor((modifier - 1) / 4) % 2 === 1;

        if (final === '~') {
          const name = TILDE_NAMES[params.split(';')[0] ?? ''] ?? 'unknown';
          out.push(key(name, sequence, { shift, ctrl }));
        } else if (CSI_NAMES[final]) {
          out.push(key(CSI_NAMES[final] as string, sequence, { shift: shift || final === 'Z', ctrl }));
        } else {
          out.push(key('unknown', sequence));
        }
        index = cursor + 1;
        continue;
      }

      if (next !== undefined && next !== ESC) {
        // Alt/Meta + character.
        out.push(key('char', chunk.slice(index, index + 2), { char: next, meta: true }));
        index += 2;
        continue;
      }

      out.push(key('escape', ESC));
      index += 1;
      continue;
    }

    const code = chunk.charCodeAt(index);

    if (code === 13 || code === 10) {
      out.push(key('enter', ch));
      index += 1;
      continue;
    }
    if (code === 9) {
      out.push(key('tab', ch));
      index += 1;
      continue;
    }
    if (code === 127 || code === 8) {
      out.push(key('backspace', ch));
      index += 1;
      continue;
    }
    if (code === 32) {
      out.push(key('space', ch, { char: ' ' }));
      index += 1;
      continue;
    }
    if (code === 3) {
      out.push(key('c', ch, { ctrl: true }));
      index += 1;
      continue;
    }
    if (code === 4) {
      out.push(key('d', ch, { ctrl: true }));
      index += 1;
      continue;
    }
    if (code < 32) {
      // Other control codes map to Ctrl+<letter>.
      out.push(key(String.fromCharCode(code + 96), ch, { ctrl: true }));
      index += 1;
      continue;
    }

    // Printable character, possibly a surrogate pair.
    const codePoint = chunk.codePointAt(index) ?? code;
    const char = String.fromCodePoint(codePoint);
    out.push(key('char', char, { char }));
    index += char.length;
  }

  return out;
}

/** True for the keys that should abort whatever is on screen. */
export function isAbort(k: Key): boolean {
  return (k.ctrl && (k.name === 'c' || k.name === 'd')) || k.name === 'escape';
}

/** True for the keys that should cancel a prompt but not the whole process. */
export function isInterrupt(k: Key): boolean {
  return k.ctrl && (k.name === 'c' || k.name === 'd');
}

/** Case-insensitive shortcut match, ignoring modifier state. */
export function isShortcut(k: Key, letter: string): boolean {
  return k.name === 'char' && !k.ctrl && !k.meta && k.char.toLowerCase() === letter.toLowerCase();
}
