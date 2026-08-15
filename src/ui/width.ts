/**
 * Display width and text layout.
 *
 * Terminal alignment breaks the moment a CJK character, an emoji or a combining
 * mark is measured with `.length`. These helpers measure printable columns so
 * boxes, tables and truncation stay aligned.
 */
import { stripAnsi } from './ansi.ts';

function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x20d0 && code <= 0x20f0) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0x200d
  );
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** Printable column count, ignoring ANSI styling. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (isCombining(code)) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

/** Truncates to `max` columns, appending an ellipsis when it had to cut. */
export function truncate(text: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  const tail = displayWidth(ellipsis);
  let width = 0;
  let out = '';
  for (const ch of stripAnsi(text)) {
    const code = ch.codePointAt(0) ?? 0;
    const chWidth = isCombining(code) ? 0 : isWide(code) ? 2 : 1;
    if (width + chWidth > max - tail) break;
    out += ch;
    width += chWidth;
  }
  return out + ellipsis;
}

export function padEnd(text: string, width: number, filler = ' '): string {
  const missing = width - displayWidth(text);
  return missing > 0 ? text + filler.repeat(missing) : text;
}

export function padStart(text: string, width: number, filler = ' '): string {
  const missing = width - displayWidth(text);
  return missing > 0 ? filler.repeat(missing) + text : text;
}

export function center(text: string, width: number): string {
  const missing = width - displayWidth(text);
  if (missing <= 0) return text;
  const left = Math.floor(missing / 2);
  return ' '.repeat(left) + text + ' '.repeat(missing - left);
}

/** Greedy word wrap that respects display width and keeps existing newlines. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim().length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (displayWidth(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line.length > 0) lines.push(line);
      // A single word longer than the width is hard-split.
      let rest = word;
      while (displayWidth(rest) > width) {
        let chunk = '';
        for (const ch of rest) {
          if (displayWidth(chunk + ch) > width) break;
          chunk += ch;
        }
        lines.push(chunk);
        rest = rest.slice(chunk.length);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/** Terminal width, clamped to something a layout can actually use. */
export function terminalWidth(fallback = 80): number {
  const columns = process.stdout.columns;
  if (!columns || Number.isNaN(columns)) return fallback;
  return Math.max(40, Math.min(columns, 120));
}
