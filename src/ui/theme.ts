/**
 * Theme system.
 *
 * One place decides colour. Everything else asks the theme for a *semantic*
 * role — `accent`, `success`, `muted` — so re-skinning RouterFlip is a single
 * table edit, and a terminal without colour support gets clean plain text
 * instead of escape-code noise.
 *
 * Capability detection follows the conventions users already expect:
 *   NO_COLOR / ROUTERFLIP_NO_COLOR  → no colour at all
 *   FORCE_COLOR / --color           → colour even when piped
 *   COLORTERM=truecolor|24bit       → 24-bit
 *   TERM=*-256color                 → 256-colour
 *   TERM=dumb                       → no colour, ASCII only
 */
import { BOLD, DIM, FG_DEFAULT, INVERSE, NO_BOLD, NO_DIM, NO_INVERSE, RESET, UNDERLINE, NO_UNDERLINE, fg256, fgBasic, fgRgb, stripAnsi } from './ansi.ts';
import type { ColorMode } from '../core/schema.ts';

export type ColorDepth = 0 | 4 | 8 | 24;

export interface Palette {
  readonly accent: readonly [number, number, number];
  readonly accentAlt: readonly [number, number, number];
  readonly success: readonly [number, number, number];
  readonly warning: readonly [number, number, number];
  readonly error: readonly [number, number, number];
  readonly muted: readonly [number, number, number];
  readonly text: readonly [number, number, number];
  readonly border: readonly [number, number, number];
}

/** Restrained developer-tool palette: one accent, three states, two greys. */
const PALETTE: Palette = {
  accent: [122, 162, 247],
  accentAlt: [187, 154, 247],
  success: [88, 197, 137],
  warning: [224, 175, 104],
  error: [235, 106, 116],
  muted: [128, 138, 158],
  text: [205, 214, 232],
  border: [88, 98, 118],
};

/** 256-colour and 16-colour stand-ins for each palette entry. */
const FALLBACK: Record<keyof Palette, { c256: number; basic: number }> = {
  accent: { c256: 111, basic: 94 },
  accentAlt: { c256: 141, basic: 95 },
  success: { c256: 78, basic: 92 },
  warning: { c256: 179, basic: 93 },
  error: { c256: 203, basic: 91 },
  muted: { c256: 245, basic: 90 },
  text: { c256: 252, basic: 39 },
  border: { c256: 240, basic: 90 },
};

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

export function detectDepth(mode: ColorMode = 'auto', stream: { isTTY?: boolean } = process.stdout): ColorDepth {
  if (mode === 'never') return 0;
  const env = process.env;
  if (mode !== 'always') {
    if (truthy(env.NO_COLOR) || truthy(env.ROUTERFLIP_NO_COLOR)) return 0;
    if (env.TERM === 'dumb') return 0;
    if (!stream.isTTY && !truthy(env.FORCE_COLOR)) return 0;
  }
  const colorTerm = (env.COLORTERM ?? '').toLowerCase();
  if (colorTerm.includes('truecolor') || colorTerm.includes('24bit')) return 24;
  if (env.WT_SESSION || env.TERM_PROGRAM === 'vscode' || env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'ghostty') return 24;
  if ((env.TERM ?? '').includes('256')) return 8;
  if (env.FORCE_COLOR === '3') return 24;
  if (env.FORCE_COLOR === '2') return 8;
  return 4;
}

/** True when the terminal can be trusted with box-drawing and bullet glyphs. */
export function detectUnicode(): boolean {
  const env = process.env;
  if (truthy(env.ROUTERFLIP_ASCII)) return false;
  if (env.TERM === 'dumb' || env.TERM === 'linux') return false;
  if (process.platform === 'win32') {
    // Windows Terminal, VS Code and modern conhost are fine; legacy conhost is
    // not, and it is the one without WT_SESSION.
    return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || env.TERM);
  }
  const encoding = `${env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? ''}`.toLowerCase();
  return encoding === '' || encoding.includes('utf');
}

export type Style = (text: string) => string;

export interface Theme {
  readonly depth: ColorDepth;
  readonly unicode: boolean;
  readonly accent: Style;
  readonly accentAlt: Style;
  readonly success: Style;
  readonly warning: Style;
  readonly error: Style;
  readonly muted: Style;
  readonly text: Style;
  readonly border: Style;
  readonly bold: Style;
  readonly dim: Style;
  readonly underline: Style;
  readonly inverse: Style;
  /** Style for the focused row in a list. */
  readonly selection: Style;
  readonly strip: (text: string) => string;
}

function colorize(role: keyof Palette, depth: ColorDepth): Style {
  if (depth === 0) return (text) => text;
  const open =
    depth === 24
      ? fgRgb(...(PALETTE[role] as unknown as [number, number, number]))
      : depth === 8
        ? fg256(FALLBACK[role].c256)
        : fgBasic(FALLBACK[role].basic);
  return (text) => `${open}${text}${FG_DEFAULT}`;
}

function wrap(open: string, close: string, depth: ColorDepth): Style {
  if (depth === 0) return (text) => text;
  return (text) => `${open}${text}${close}`;
}

export function createTheme(mode: ColorMode = 'auto', stream: { isTTY?: boolean } = process.stdout): Theme {
  const depth = detectDepth(mode, stream);
  const unicode = detectUnicode();
  const accent = colorize('accent', depth);
  return {
    depth,
    unicode,
    accent,
    accentAlt: colorize('accentAlt', depth),
    success: colorize('success', depth),
    warning: colorize('warning', depth),
    error: colorize('error', depth),
    muted: colorize('muted', depth),
    text: colorize('text', depth),
    border: colorize('border', depth),
    bold: wrap(BOLD, NO_BOLD, depth),
    dim: wrap(DIM, NO_DIM, depth),
    underline: wrap(UNDERLINE, NO_UNDERLINE, depth),
    inverse: wrap(INVERSE, NO_INVERSE, depth),
    selection: (text) => (depth === 0 ? text : `${BOLD}${accent(text)}${NO_BOLD}`),
    strip: stripAnsi,
  };
}

/** The process-wide theme. Replaced once at startup after flags are parsed. */
let current: Theme = createTheme('auto');

export function theme(): Theme {
  return current;
}

export function setTheme(next: Theme): void {
  current = next;
}

export { RESET };
