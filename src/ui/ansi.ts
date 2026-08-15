/**
 * Raw ANSI/VT sequences.
 *
 * The escape byte is built with `String.fromCharCode(27)` rather than written
 * literally so no source file in this project contains raw control characters —
 * they survive copy/paste, diffs, and code review badly.
 *
 * Nothing here decides *whether* to emit colour; that is `theme.ts`. This module
 * is the vocabulary, the theme is the policy.
 */
export const ESC = String.fromCharCode(27);
export const CSI = `${ESC}[`;

// ── Styling ────────────────────────────────────────────────────────────────
export const RESET = `${CSI}0m`;
export const BOLD = `${CSI}1m`;
export const DIM = `${CSI}2m`;
export const UNDERLINE = `${CSI}4m`;
export const INVERSE = `${CSI}7m`;
export const NO_BOLD = `${CSI}22m`;
export const NO_DIM = `${CSI}22m`;
export const NO_UNDERLINE = `${CSI}24m`;
export const NO_INVERSE = `${CSI}27m`;

/** 24-bit foreground/background. Downgraded by the theme when unsupported. */
export function fgRgb(r: number, g: number, b: number): string {
  return `${CSI}38;2;${r};${g};${b}m`;
}
/** 256-colour fallback. */
export function fg256(index: number): string {
  return `${CSI}38;5;${index}m`;
}
/** Basic 16-colour fallback (30–37 / 90–97). */
export function fgBasic(code: number): string {
  return `${CSI}${code}m`;
}
export const FG_DEFAULT = `${CSI}39m`;

// ── Cursor and screen ──────────────────────────────────────────────────────
export const CURSOR_HIDE = `${CSI}?25l`;
export const CURSOR_SHOW = `${CSI}?25h`;
export const CURSOR_HOME = `${CSI}H`;
export const CLEAR_SCREEN = `${CSI}2J`;
export const CLEAR_SCROLLBACK = `${CSI}3J`;
export const CLEAR_LINE = `${CSI}2K`;
export const CLEAR_TO_END = `${CSI}0J`;
export const ALT_SCREEN_ENTER = `${CSI}?1049h`;
export const ALT_SCREEN_EXIT = `${CSI}?1049l`;
export const SYNC_START = `${CSI}?2026h`;
export const SYNC_END = `${CSI}?2026l`;

export function cursorTo(row: number, column = 1): string {
  return `${CSI}${Math.max(1, row)};${Math.max(1, column)}H`;
}
export function cursorUp(n = 1): string {
  return n > 0 ? `${CSI}${n}A` : '';
}

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');

/** Strips styling so widths can be measured and output can be captured. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
