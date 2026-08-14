/**
 * Glyphs.
 *
 * Every symbol has an ASCII twin. `detectUnicode()` decides which set is used,
 * so RouterFlip degrades to something legible on a legacy console instead of
 * printing mojibake.
 */
import { theme } from './theme.ts';

interface GlyphSet {
  readonly ok: string;
  readonly fail: string;
  readonly warn: string;
  readonly info: string;
  readonly pointer: string;
  readonly activeDot: string;
  readonly inactiveDot: string;
  readonly bullet: string;
  readonly arrowRight: string;
  readonly ellipsis: string;
  readonly line: string;
  readonly boxTopLeft: string;
  readonly boxTopRight: string;
  readonly boxBottomLeft: string;
  readonly boxBottomRight: string;
  readonly boxHorizontal: string;
  readonly boxVertical: string;
  readonly boxTeeLeft: string;
  readonly boxTeeRight: string;
  readonly spinner: readonly string[];
  readonly maskChar: string;
}

const UNICODE: GlyphSet = {
  ok: '✓',
  fail: '✗',
  warn: '!',
  info: 'i',
  pointer: '❯',
  activeDot: '●',
  inactiveDot: '○',
  bullet: '•',
  arrowRight: '→',
  ellipsis: '…',
  line: '─',
  boxTopLeft: '╭',
  boxTopRight: '╮',
  boxBottomLeft: '╰',
  boxBottomRight: '╯',
  boxHorizontal: '─',
  boxVertical: '│',
  boxTeeLeft: '├',
  boxTeeRight: '┤',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  maskChar: '•',
};

const ASCII: GlyphSet = {
  ok: '+',
  fail: 'x',
  warn: '!',
  info: 'i',
  pointer: '>',
  activeDot: '*',
  inactiveDot: 'o',
  bullet: '-',
  arrowRight: '->',
  ellipsis: '...',
  line: '-',
  boxTopLeft: '+',
  boxTopRight: '+',
  boxBottomLeft: '+',
  boxBottomRight: '+',
  boxHorizontal: '-',
  boxVertical: '|',
  boxTeeLeft: '+',
  boxTeeRight: '+',
  spinner: ['|', '/', '-', '\\'],
  maskChar: '*',
};

export function glyphs(): GlyphSet {
  return theme().unicode ? UNICODE : ASCII;
}

// ── Coloured status markers ────────────────────────────────────────────────
export function iconOk(): string {
  return theme().success(glyphs().ok);
}
export function iconFail(): string {
  return theme().error(glyphs().fail);
}
export function iconWarn(): string {
  return theme().warning(glyphs().warn);
}
export function iconInfo(): string {
  return theme().accent(glyphs().info);
}
export function iconPending(): string {
  return theme().muted(glyphs().bullet);
}
