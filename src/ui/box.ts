/**
 * Box drawing and layout primitives.
 *
 * These return arrays of strings rather than printing, which keeps them pure and
 * makes them straightforward to snapshot in tests.
 */
import { glyphs } from './icons.ts';
import { theme } from './theme.ts';
import { center, displayWidth, padEnd, truncate, wrapText } from './width.ts';

export interface BoxOptions {
  readonly width: number;
  readonly title?: string;
  readonly subtitle?: string;
  /** Centre the body lines instead of left-aligning them. */
  readonly centered?: boolean;
  readonly padding?: number;
}

/** A rounded box with an optional centred title/subtitle header. */
export function box(lines: readonly string[], options: BoxOptions): string[] {
  const g = glyphs();
  const t = theme();
  const pad = options.padding ?? 1;
  const inner = Math.max(4, options.width - 2 - pad * 2);
  const edge = (left: string, right: string) => t.border(left + g.boxHorizontal.repeat(options.width - 2) + right);

  const out: string[] = [edge(g.boxTopLeft, g.boxTopRight)];
  const body: string[] = [];

  // Truncate the header too: a tagline wider than the box would push the right
  // border out and skew every line below it in a narrow terminal.
  if (options.title) body.push(t.bold(t.accent(center(truncate(options.title, inner), inner))));
  if (options.subtitle) body.push(t.muted(center(truncate(options.subtitle, inner), inner)));
  if ((options.title || options.subtitle) && lines.length > 0) body.push('');
  for (const line of lines) {
    body.push(options.centered ? center(truncate(line, inner), inner) : truncate(line, inner));
  }

  for (const line of body) {
    const padded = padEnd(line, inner);
    out.push(`${t.border(g.boxVertical)}${' '.repeat(pad)}${padded}${' '.repeat(pad)}${t.border(g.boxVertical)}`);
  }
  out.push(edge(g.boxBottomLeft, g.boxBottomRight));
  return out;
}

/** The RouterFlip masthead used by the dashboard and by `add`. */
export function banner(title: string, subtitle: string | undefined, width: number): string[] {
  return box([], { width, title, subtitle: subtitle ?? undefined, padding: 1 });
}

/** A horizontal rule, indented to match body content. */
export function rule(width: number, indent = 2): string {
  const g = glyphs();
  return ' '.repeat(indent) + theme().border(g.boxHorizontal.repeat(Math.max(1, width - indent * 2)));
}

export interface TableColumn {
  readonly header: string;
  readonly align?: 'left' | 'right';
  /** Maximum width; the column shrinks to fit its contents. */
  readonly max?: number;
}

/** A minimal, borderless table — the style `gh` and `pnpm` use. */
export function table(columns: readonly TableColumn[], rows: readonly (readonly string[])[], indent = 2): string[] {
  const t = theme();
  const widths = columns.map((column, index) => {
    const contentWidth = Math.max(displayWidth(column.header), ...rows.map((row) => displayWidth(row[index] ?? '')));
    return Math.min(contentWidth, column.max ?? contentWidth);
  });
  const renderRow = (cells: readonly string[], style: (text: string) => string) =>
    ' '.repeat(indent) +
    cells
      .map((cell, index) => {
        const width = widths[index] ?? 0;
        const clipped = truncate(cell, width);
        return columns[index]?.align === 'right'
          ? ' '.repeat(Math.max(0, width - displayWidth(clipped))) + style(clipped)
          : style(padEnd(clipped, width));
      })
      .join('  ')
      .replace(/\s+$/, '');

  return [
    renderRow(
      columns.map((column) => column.header.toUpperCase()),
      (text) => t.dim(t.bold(text)),
    ),
    ...rows.map((row) => renderRow(row, (text) => text)),
  ];
}

/** Wraps `text` into an indented paragraph. */
export function paragraph(text: string, width: number, indent = 2): string[] {
  return wrapText(text, Math.max(20, width - indent * 2)).map((line) => ' '.repeat(indent) + line);
}

/**
 * The slice of `blocks` that fits in `room` rows, centred on `focus`, with the
 * `N more above` / `N more below` markers the dashboard's lists use.
 *
 * One block is one list entry — one row, or two when the entry has a detail line —
 * and blocks are kept whole, so a wrapped entry is never cut in half. The window is
 * derived from `focus` rather than kept as scroll state, so a resize can never
 * desynchronise it.
 */
export function windowBlocks(blocks: readonly (readonly string[])[], focus: number, room: number): string[] {
  const t = theme();
  const flatten = (from: number, to: number): string[] => blocks.slice(from, to).flatMap((block) => [...block]);
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  if (total <= room) return flatten(0, blocks.length);

  // Both markers are budgeted for up front: at most one row of slack, against the
  // alternative of a two-pass fit for a line the caller pads over anyway.
  const budget = Math.max(1, room - 2);
  let first = Math.max(0, Math.min(focus, blocks.length - 1));
  let last = first;
  let used = blocks[first]?.length ?? 0;
  // Grow downwards and upwards in turn, which lands the cursor mid-window the way
  // the dashboard's index arithmetic does for its fixed-height rows.
  for (let turn = 0; ; turn += 1) {
    const down = last + 1 < blocks.length ? (blocks[last + 1]?.length ?? 0) : undefined;
    const up = first > 0 ? (blocks[first - 1]?.length ?? 0) : undefined;
    const goDown = down !== undefined && used + down <= budget;
    const goUp = up !== undefined && used + up <= budget;
    if (goDown && (turn % 2 === 0 || !goUp)) {
      used += down ?? 0;
      last += 1;
    } else if (goUp) {
      used += up ?? 0;
      first -= 1;
    } else break;
  }

  const out = flatten(first, last + 1);
  if (first > 0) out.unshift(`  ${t.dim(`${first} more above`)}`);
  const below = blocks.length - 1 - last;
  if (below > 0) out.push(`  ${t.dim(`${below} more below`)}`);
  return out;
}
