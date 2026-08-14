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

/** A `LABEL` heading in the dashboard's section style. */
export function sectionHeading(label: string, indent = 2): string {
  return ' '.repeat(indent) + theme().dim(theme().bold(label.toUpperCase()));
}

/** Label above value, the layout used across `current`, `test` and forms. */
export function fieldBlock(label: string, value: string, indent = 0): string[] {
  const t = theme();
  const prefix = ' '.repeat(indent);
  return [`${prefix}${t.muted(label)}`, `${prefix}${value}`];
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
