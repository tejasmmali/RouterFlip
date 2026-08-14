/**
 * Views (spec §18 "terminal UX", §19 "theme system", §23 "always mask").
 *
 * Every renderer returns lines instead of printing, which is what makes the UI
 * testable without a TTY — and the reason `routerflip list` and the interactive
 * list cannot drift apart. What is pinned here is the user-visible contract:
 * which glyph means "active", where the mask appears (and that the secret never
 * does), that the empty state names the command that fixes it, and that
 * `--color never` really produces plain text.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAGLINE,
  bannerLines,
  emptyStateLines,
  keybar,
  relativeTime,
  routerDetailLines,
  routerListLines,
  routerRow,
  routerTableLines,
  testReportLines,
} from '../src/ui/views.ts';
import { createTheme, setTheme, theme } from '../src/ui/theme.ts';
import { glyphs } from '../src/ui/icons.ts';
import { displayWidth } from '../src/ui/width.ts';
import { maskSecret } from '../src/core/mask.ts';
import type { RouterView } from '../src/core/routers.ts';
import type { TestReport } from '../src/services/tester.ts';
import { TEST_KEY } from './helpers.ts';

const ESC = String.fromCharCode(27);

/** Plain text for every assertion below, on any terminal. */
before(() => setTheme(createTheme('never', { isTTY: false })));

function makeView(overrides: Partial<RouterView> = {}): RouterView {
  return {
    id: 'alpha-1',
    name: 'Alpha',
    baseUrl: 'https://api.alpha.example',
    description: 'Primary gateway',
    maskedKey: maskSecret(TEST_KEY),
    hasKey: true,
    authEnvVar: 'ANTHROPIC_API_KEY',
    provider: 'claude-code',
    isActive: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('a router row puts the name on one line and the URL beneath it', () => {
  const lines = routerRow(makeView(), false);
  assert.equal(lines.length, 2, 'two lines per router is what keeps long URLs readable');
  assert.match(lines[0] ?? '', /Alpha/);
  assert.equal((lines[0] ?? '').includes('https://'), false, 'the URL belongs on the second line');
  assert.match(lines[1] ?? '', /https:\/\/api\.alpha\.example/);
});

test('the focused row is the only one that gets the pointer', () => {
  const g = glyphs();
  const focused = routerRow(makeView(), true)[0] ?? '';
  const idle = routerRow(makeView(), false)[0] ?? '';

  assert.equal(focused.includes(g.pointer), true, 'the cursor must be visible without colour');
  assert.equal(idle.includes(g.pointer), false);
  assert.equal(displayWidth(focused), displayWidth(idle), 'the pointer replaces a space, so rows do not shift');
});

test('active and inactive routers are distinguishable by glyph, not only by colour', () => {
  const g = glyphs();
  const active = routerRow(makeView({ isActive: true }), false)[0] ?? '';
  const idle = routerRow(makeView(), false)[0] ?? '';

  assert.equal(active.includes(g.activeDot), true);
  assert.match(active, /current/);
  assert.equal(idle.includes(g.inactiveDot), true);
  assert.equal(/current/.test(idle), false);
});

test('a router with no stored key says so in the list and in the detail view', () => {
  const view = makeView({ hasKey: false, maskedKey: maskSecret(undefined) });
  assert.match(routerRow(view, false)[0] ?? '', /no key/);
  assert.match(routerTableLines([view]).join('\n'), /missing/);
  assert.match(routerDetailLines(view).join('\n'), /not stored/);
});

test('a cursor of -1 means nothing is focused', () => {
  const g = glyphs();
  const lines = routerListLines([makeView(), makeView({ id: 'beta-1', name: 'Beta' })]);
  assert.equal(lines.length, 4);
  assert.equal(lines.join('\n').includes(g.pointer), false);
});

test('the detail view shows the mask and never the key itself', () => {
  const text = routerDetailLines(makeView({ isActive: true })).join('\n');

  assert.equal(text.includes(TEST_KEY), false, 'the whole point of the mask');
  assert.equal(text.includes('sk-test'), false, 'not even the prefix');
  assert.match(text, /cdef/, 'the last four characters identify which key this is');
  assert.match(text, /API Key/);
  assert.match(text, /Base URL/);
  assert.match(text, /current/);
  assert.match(text, /ANTHROPIC_API_KEY/, 'which variable will be set is part of the decision');
});

test('the table has a header row and masks the key column', () => {
  const lines = routerTableLines([makeView({ isActive: true }), makeView({ id: 'beta-1', name: 'Beta' })]);

  assert.equal(lines.length, 3, 'one header plus one row per router');
  assert.match(lines[0] ?? '', /NAME/);
  assert.match(lines[0] ?? '', /BASE URL/);
  assert.match(lines[0] ?? '', /KEY/);
  assert.equal(lines.join('\n').includes(TEST_KEY), false);
  assert.match(lines[1] ?? '', /Alpha/);
  assert.match(lines[2] ?? '', /Beta/);
});

test('the key hints are exactly the ones the spec lists, in order', () => {
  const bar = theme().strip(keybar());
  const expected = ['Navigate', 'Select', 'Add', 'Edit', 'Delete', 'Test', 'Current', 'Quit'];
  let cursor = -1;
  for (const label of expected) {
    const at = bar.indexOf(label);
    assert.ok(at > cursor, `${label} is missing or out of order`);
    cursor = at;
  }
  for (const key of ['Enter', 'A', 'E', 'D', 'T', 'C', 'Q']) assert.match(bar, new RegExp(key));
});

test('the empty state names the command that fixes it', () => {
  const text = emptyStateLines(60).join('\n');
  assert.match(text, /No Routers Yet/);
  assert.match(text, /routerflip add/);
  assert.match(text, /press A/, 'the dashboard offers the same action without retyping');
});

test('boxes are exactly as wide as they are asked to be', () => {
  for (const width of [40, 58, 72]) {
    for (const line of bannerLines(width)) {
      assert.equal(displayWidth(line), width, `banner line is not ${width} columns wide`);
    }
  }
  assert.match(bannerLines(72).join('\n'), /RouterFlip/);
  assert.match(bannerLines(72).join('\n'), new RegExp(TAGLINE.slice(0, 20)));
});

test('a finished test run renders one row per step, with latency and detail', () => {
  const report: TestReport = {
    ok: false,
    routerId: 'alpha-1',
    routerName: 'Alpha',
    baseUrl: 'https://api.alpha.example',
    endpoint: 'https://api.alpha.example/v1/messages',
    steps: [
      { key: 'url', label: 'URL format', status: 'pass' },
      { key: 'reachable', label: 'Network reachable', status: 'pass', latencyMs: 42 },
      { key: 'endpoint', label: 'Endpoint responding', status: 'warn', detail: 'HTTP 404.' },
      { key: 'auth', label: 'Credential accepted', status: 'skip' },
    ],
  };
  const lines = testReportLines(report);

  assert.equal(lines.length, 5, 'four steps plus the one detail line');
  assert.match(lines[1] ?? '', /42ms/);
  assert.match(lines[2] ?? '', /Endpoint responding/);
  assert.match(lines[3] ?? '', /HTTP 404\./);
  assert.equal((lines[0] ?? '').includes(glyphs().ok), true, 'a pass is marked, not merely coloured');
});

test('colour is a theme decision, not something baked into the views', () => {
  const plain = routerRow(makeView({ isActive: true }), true).join('\n');
  assert.equal(plain.includes(ESC), false, '--color never must emit no escape sequences at all');

  setTheme(createTheme('always', { isTTY: false }));
  try {
    const coloured = routerRow(makeView({ isActive: true }), true).join('\n');
    assert.equal(coloured.includes(ESC), true, 'the same view colours itself when the theme allows it');
    assert.equal(theme().strip(coloured), plain, 'colour adds nothing to the text, only to its styling');
  } finally {
    setTheme(createTheme('never', { isTTY: false }));
  }
});

test('timestamps are rendered the way a person reads them', () => {
  const ago = (seconds: number) => relativeTime(new Date(Date.now() - seconds * 1000).toISOString());

  assert.equal(ago(2), 'just now');
  assert.equal(ago(60), '1 minute ago');
  assert.equal(ago(600), '10 minutes ago');
  assert.equal(ago(7200), '2 hours ago');
  assert.equal(ago(172_800), '2 days ago');
  assert.equal(relativeTime('not a date'), 'not a date', 'an unparsable value is shown as-is, not as NaN');
});
