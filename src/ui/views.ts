/**
 * Shared views.
 *
 * The dashboard and the plain commands must show the *same* router the same way,
 * so every renderer lives here and returns lines rather than printing. That keeps
 * `routerflip list` and the interactive list byte-identical, and makes each view
 * snapshot-testable without a terminal.
 */
import type { AccountView, RouterView } from '../core/routers.ts';
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

/**
 * The bottom command bar every interactive screen ends with: accented key,
 * muted label, two spaces between pairs. One builder, so no screen can drift
 * into a footer of its own — a new screen gets the look by listing its keys.
 */
function keyHints(entries: readonly (readonly [string, string])[]): string {
  const t = theme();
  return entries.map(([key, label]) => `${t.accent(key)} ${t.muted(label)}`).join('  ');
}

/** The dashboard's key hints, in the order the spec lists them. */
export function keybar(): string {
  return keyHints([
    [arrowsGlyph(), 'Navigate'],
    ['Enter', 'Select'],
    ['A', 'Add'],
    ['E', 'Edit'],
    ['D', 'Delete'],
    ['T', 'Test'],
    ['C', 'Current'],
    ['Q', 'Quit'],
  ]);
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
 *
 * Account information is added only when there is more than one account, so a
 * single-account setup looks exactly as it did before accounts existed.
 */
export function routerRow(view: RouterView, focused: boolean): string[] {
  const t = theme();
  const g = glyphs();
  const pointer = focused ? t.accent(g.pointer) : ' ';
  const name = focused ? t.selection(view.name) : t.text(view.name);
  const tags: string[] = [];
  if (view.isActive) tags.push(t.success('current'));
  // A router with no accounts has no key by definition; saying both would be noise.
  if (view.accountCount === 0) tags.push(t.warning('no accounts'));
  else if (!view.hasKey) tags.push(t.warning('no key'));
  const suffix = tags.length > 0 ? `  ${t.dim('[')}${tags.join(t.dim(', '))}${t.dim(']')}` : '';
  // What the router offers, in the order it is asked about: how many models it
  // serves, then how many credentials it holds. Both are omitted when there is
  // nothing to say, so a single-account router with no models keeps its old shape.
  const facts: string[] = [];
  if (view.models.length > 0) facts.push(`${view.models.length} model${view.models.length === 1 ? '' : 's'}`);
  if (view.accountCount > 1) facts.push(`${view.accountCount} accounts`);
  const count = facts.length > 0 ? `    ${t.dim(facts.join(' · '))}` : '';
  // Which account is selected only matters when there is a choice to be made. The
  // model is shown whenever one is chosen, because it changes what a launch does —
  // and a router that has never chosen one keeps exactly its old single-line shape.
  const trailing: string[] = [];
  if (view.accountCount > 1 && view.activeAccountName) {
    trailing.push(`${t.muted(view.activeAccountName)} ${t.dim(view.maskedKey)}`);
  }
  if (view.model) trailing.push(t.muted(view.model));
  const selected = trailing.map((bit) => `  ${t.dim('·')}  ${bit}`).join('');
  return [`  ${pointer} ${dot(view)} ${name}${count}${suffix}`, `        ${t.dim(view.baseUrl)}${selected}`];
}

export function routerListLines(views: readonly RouterView[], cursor = -1): string[] {
  const out: string[] = [];
  views.forEach((view, index) => out.push(...routerRow(view, index === cursor)));
  return out;
}

/**
 * How many accounts a router has, and which one is selected.
 *
 * Only spelled out when there is a choice: one account is the shape every
 * pre-accounts config has, and repeating its name in every row would be noise.
 */
function accountCell(view: RouterView): string {
  const t = theme();
  if (view.accountCount === 0) return t.warning('none');
  if (view.accountCount === 1) return t.dim('1');
  return `${view.accountCount}${view.activeAccountName ? t.dim(` · ${view.activeAccountName}`) : ''}`;
}

/** Borderless table used by `routerflip list`. */
export function routerTableLines(views: readonly RouterView[]): string[] {
  const t = theme();
  const g = glyphs();
  return table(
    [
      { header: '', max: 1 },
      { header: 'name', max: 24 },
      { header: 'base url', max: 44 },
      { header: 'accounts', max: 20 },
      { header: 'key' },
      { header: 'description', max: 28 },
    ],
    views.map((view) => [
      view.isActive ? t.success(g.activeDot) : t.muted(g.inactiveDot),
      view.isActive ? t.bold(view.name) : view.name,
      t.muted(view.baseUrl),
      accountCell(view),
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
  // Only mentioned once models are in play: a router that has never offered one
  // launches with the provider's own default, and saying so every time is noise.
  if (view.model) out.push('', ...field('Model', t.text(view.modelLabel ?? view.model)));
  else if (view.models.length > 0) out.push('', ...field('Model', t.dim('none selected')));
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

// ── Accounts ────────────────────────────────────────────────────────────────
//
// A router owns the base URL; each of its accounts owns one credential. The
// account screen therefore repeats the router's identity in its header, and shows
// nothing but names and masks below it — never a key.

/** Masthead of the account screen: the router's name over its base URL. */
export function accountBannerLines(view: RouterView, width: number): string[] {
  return box([], { width, title: view.name, subtitle: view.baseUrl });
}

/** The account screen's key hints. `B` goes back rather than quitting. */
export function accountKeybar(): string {
  return keyHints([
    [arrowsGlyph(), 'Navigate'],
    ['Enter', 'Select'],
    ['A', 'Add Account'],
    ['E', 'Edit'],
    ['D', 'Delete'],
    ['M', 'Model'],
    ['B', 'Back'],
  ]);
}

/**
 * The model picker's key hints.
 *
 * `filtering` is the long-list mode, where every printable key types into the
 * filter box: the letter shortcuts genuinely do not fire there, so promising
 * them would be a lie. The rows themselves stay, so nothing becomes unreachable,
 * and the picker's own `Filter` line already says that typing filters.
 */
export function modelKeybar(filtering = false): string {
  if (filtering) {
    return keyHints([
      [arrowsGlyph(), 'Navigate'],
      ['Enter', 'Select'],
      ['Esc', 'Cancel'],
    ]);
  }
  return keyHints([
    [arrowsGlyph(), 'Navigate'],
    ['Enter', 'Select'],
    ['R', 'Refresh Models'],
    ['A', 'Add Custom Model'],
    ['B', 'Back'],
    ['Esc', 'Cancel'],
  ]);
}

/**
 * One account: name on its own row, mask dimmed beneath.
 *
 * Deliberately the same two-line shape as `routerRow` — the account screen is
 * reached by pressing Enter on a router row, so anything else would read as a
 * different application.
 */
export function accountRow(view: AccountView, focused: boolean): string[] {
  const t = theme();
  const g = glyphs();
  const pointer = focused ? t.accent(g.pointer) : ' ';
  const marker = view.isActive ? t.success(g.activeDot) : t.muted(g.inactiveDot);
  const name = focused ? t.selection(view.name) : t.text(view.name);
  const tags: string[] = [];
  if (view.isActive) tags.push(t.success('active'));
  if (!view.hasKey) tags.push(t.warning('no key'));
  const suffix = tags.length > 0 ? `  ${t.dim('[')}${tags.join(t.dim(', '))}${t.dim(']')}` : '';
  // The mask, never the key: this row is on screen whenever the screen is.
  const model = view.model ? `  ${t.dim('·')}  ${t.muted(view.model)}` : '';
  const description = view.description ? `  ${t.dim('·')}  ${t.muted(view.description)}` : '';
  return [`  ${pointer} ${marker} ${name}${suffix}`, `        ${t.dim(view.maskedKey)}${model}${description}`];
}

export function accountListLines(views: readonly AccountView[], cursor = -1): string[] {
  const out: string[] = [];
  views.forEach((view, index) => out.push(...accountRow(view, index === cursor)));
  return out;
}

/**
 * The empty state for a router with no accounts left.
 *
 * Reachable by deleting the last account, so it names both ways out — the key
 * that works right here and the command that works from a shell.
 */
export function emptyAccountsLines(routerName: string, width: number): string[] {
  const t = theme();
  return box(
    [
      t.muted(`${routerName} has no accounts, so there is no key to launch with.`),
      '',
      `${t.text('Add one with')}  ${t.accent(`routerflip accounts ${routerName}`)}`,
      t.dim('or press A right here.'),
    ],
    { width, title: 'No Accounts Yet' },
  );
}

/** Detail block for one account: shown before deleting, and by `current`. */
export function accountDetailLines(view: AccountView, indent = 2): string[] {
  const t = theme();
  const pad = ' '.repeat(indent);
  const field = (label: string, value: string): string[] => [`${pad}${t.muted(label)}`, `${pad}${value}`];
  const out: string[] = [
    ...field('Account', `${t.bold(view.name)}${view.isActive ? t.success('  (active)') : ''}`),
    '',
    ...field('API Key', view.hasKey ? t.dim(view.maskedKey) : t.warning('not stored')),
  ];
  if (view.description) out.push('', ...field('Description', view.description));
  // Absent means "whatever the provider defaults to", which is a legitimate state
  // rather than a gap, so nothing is printed for an account that has not chosen.
  if (view.model) out.push('', ...field('Model', t.text(view.model)));
  return out;
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
