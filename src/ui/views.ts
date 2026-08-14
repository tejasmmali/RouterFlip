/**
 * Shared views.
 *
 * The dashboard and the plain commands must show the *same* router the same way,
 * so every renderer lives here and returns lines rather than printing. That keeps
 * `routerflip list` and the interactive list byte-identical, and makes each view
 * snapshot-testable without a terminal.
 */
import type { RouterView } from '../core/routers.ts';
import type { CheckStatus } from '../services/doctor.ts';
import type { StepStatus, TestReport } from '../services/tester.ts';
import { box, table } from './box.ts';
import { glyphs, iconFail, iconInfo, iconOk, iconPending, iconWarn } from './icons.ts';
import { theme } from './theme.ts';

export const TAGLINE = 'Switch your Claude Code gateway in seconds';

export function bannerLines(width: number): string[] {
  return box([], { width, title: 'RouterFlip', subtitle: TAGLINE });
}

/** `↑↓` where the terminal can draw it, `Up/Dn` where it cannot. */
function arrowsGlyph(): string {
  return theme().unicode ? '↑↓' : 'Up/Dn';
}

/** The dashboard's key hints, in the order the spec lists them. */
export function keybar(): string {
  const t = theme();
  const entries: readonly (readonly [string, string])[] = [
    [arrowsGlyph(), 'Navigate'],
    ['Enter', 'Select'],
    ['A', 'Add'],
    ['E', 'Edit'],
    ['D', 'Delete'],
    ['T', 'Test'],
    ['C', 'Current'],
    ['Q', 'Quit'],
  ];
  return entries.map(([key, label]) => `${t.accent(key)} ${t.muted(label)}`).join('  ');
}

/** Status marker for a router row: filled dot for active, hollow otherwise. */
function dot(view: RouterView): string {
  const t = theme();
  const g = glyphs();
  return view.isActive ? t.success(g.activeDot) : t.muted(g.inactiveDot);
}

/**
 * One router as it appears in a list: name on its own row, URL dimmed beneath.
 * Two lines per router is what makes the list readable when URLs are long.
 */
export function routerRow(view: RouterView, focused: boolean): string[] {
  const t = theme();
  const g = glyphs();
  const pointer = focused ? t.accent(g.pointer) : ' ';
  const name = focused ? t.selection(view.name) : t.text(view.name);
  const tags: string[] = [];
  if (view.isActive) tags.push(t.success('current'));
  if (!view.hasKey) tags.push(t.warning('no key'));
  const suffix = tags.length > 0 ? `  ${t.dim('[')}${tags.join(t.dim(', '))}${t.dim(']')}` : '';
  return [`  ${pointer} ${dot(view)} ${name}${suffix}`, `        ${t.dim(view.baseUrl)}`];
}

export function routerListLines(views: readonly RouterView[], cursor = -1): string[] {
  const out: string[] = [];
  views.forEach((view, index) => out.push(...routerRow(view, index === cursor)));
  return out;
}

/** Borderless table used by `routerflip list`. */
export function routerTableLines(views: readonly RouterView[]): string[] {
  const t = theme();
  const g = glyphs();
  return table(
    [{ header: '', max: 1 }, { header: 'name', max: 24 }, { header: 'base url', max: 48 }, { header: 'key' }, { header: 'description', max: 32 }],
    views.map((view) => [
      view.isActive ? t.success(g.activeDot) : t.muted(g.inactiveDot),
      view.isActive ? t.bold(view.name) : view.name,
      t.muted(view.baseUrl),
      view.hasKey ? t.dim(view.maskedKey) : t.warning('missing'),
      t.dim(view.description),
    ]),
  );
}

/** Detail block shown before choosing temporary vs permanent, and by `current`. */
export function routerDetailLines(view: RouterView, indent = 2): string[] {
  const t = theme();
  const pad = ' '.repeat(indent);
  const field = (label: string, value: string): string[] => [`${pad}${t.muted(label)}`, `${pad}${value}`];
  const out: string[] = [
    ...field('Router', `${t.bold(view.name)}${view.isActive ? t.success('  (current)') : ''}`),
    '',
    ...field('Base URL', view.baseUrl),
    '',
    // Never the key itself — only ever the fixed-width mask.
    ...field('API Key', view.hasKey ? t.dim(view.maskedKey) : t.warning('not stored')),
  ];
  if (view.description) out.push('', ...field('Description', view.description));
  out.push('', ...field('Auth variable', t.dim(view.authEnvVar)));
  return out;
}

/** The `No Routers Yet` empty state from spec §18. */
export function emptyStateLines(width: number): string[] {
  const t = theme();
  return [
    ...box(
      [
        t.muted('RouterFlip has no gateways configured.'),
        '',
        `${t.text('Add your first one with')}  ${t.accent('routerflip add')}`,
        t.dim('or press A right here.'),
      ],
      { width, title: 'No Routers Yet' },
    ),
  ];
}

export function checkIcon(status: CheckStatus): string {
  if (status === 'ok') return iconOk();
  if (status === 'warn') return iconWarn();
  if (status === 'fail') return iconFail();
  return iconInfo();
}

export function stepIcon(status: StepStatus): string {
  if (status === 'pass') return iconOk();
  if (status === 'warn') return iconWarn();
  if (status === 'fail') return iconFail();
  return iconPending();
}

/** The four-row checklist of a finished test run. */
export function testReportLines(report: TestReport, indent = 2): string[] {
  const t = theme();
  const pad = ' '.repeat(indent);
  const out: string[] = [];
  for (const step of report.steps) {
    const latency = step.latencyMs === undefined ? '' : t.dim(`  ${step.latencyMs}ms`);
    const label = step.status === 'skip' ? t.dim(step.label) : step.label;
    out.push(`${pad}${stepIcon(step.status)} ${label}${latency}`);
    if (step.detail) out.push(`${pad}    ${t.dim(step.detail)}`);
  }
  return out;
}

/** "3 minutes ago" — used wherever a timestamp is shown to a human. */
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return 'just now';
  const scale: readonly (readonly [number, string])[] = [
    [31_536_000, 'year'],
    [2_592_000, 'month'],
    [604_800, 'week'],
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, unit] of scale) {
    if (seconds < size) continue;
    const value = Math.floor(seconds / size);
    return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
  }
  return `${seconds} seconds ago`;
}
