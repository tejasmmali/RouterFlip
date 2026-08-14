/**
 * `routerflip doctor` (spec §14, §20 and §25: "missing Claude executable").
 *
 * doctor is the command a user runs when something is wrong, so its own failure
 * modes matter more than most: an uninstalled Claude Code, a settings file it
 * cannot parse, or a key that has vanished from the keychain must all come back
 * as *rows in a report*, never as a stack trace. It also has to stay presence-only
 * about secrets while reading an environment that may genuinely contain them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, type Check, type DoctorReport } from '../src/services/doctor.ts';
import { loadState, saveState } from '../src/core/store.ts';
import { RouterFlipError } from '../src/errors.ts';
import type { Provider } from '../src/providers/types.ts';
import { sandboxService, withSandbox, TEST_KEY } from './helpers.ts';

/** A provider that answers every question without touching a real CLI. */
function stubProvider(overrides: Partial<Provider> = {}): Provider {
  const base: Provider = {
    id: 'claude-code',
    label: 'Claude Code',
    commands: ['claude'],
    mechanism: 'Environment variables for temporary mode; settings.json for permanent mode.',
    detect: async () => ({ found: true, executable: '/usr/local/bin/claude', command: 'claude', version: '2.1.232' }),
    envFor: () => ({}),
    conflicts: () => [],
    envKeys: () => [],
    configFile: () => '/tmp/settings.json',
    inspect: () => ({ file: '/tmp/settings.json', exists: false, hasAuth: false, otherEnvKeys: [], preservedKeys: [] }),
    applyPermanent: () => assert.fail('doctor must never write configuration'),
    clearPermanent: () => assert.fail('doctor must never write configuration'),
  };
  return { ...base, ...overrides };
}

function checkFor(report: DoctorReport, label: string): Check {
  const found = report.sections.flatMap((section) => section.checks).find((check) => check.label === label);
  assert.ok(found, `expected a "${label}" check; got ${report.sections.flatMap((s) => s.checks).map((c) => c.label).join(', ')}`);
  return found;
}

test('a machine with nothing configured yields a healthy report and a next step', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    const report = await runDoctor({ service, credentials, provider: stubProvider() });

    assert.equal(report.healthy, true, 'nothing configured is not the same as broken');
    assert.equal(report.routerCount, 0);
    assert.equal(report.activeRouter, undefined);
    assert.equal(checkFor(report, 'Routers').detail, 'none configured');
    assert.match(checkFor(report, 'Routers').hint ?? '', /routerflip add/);
    assert.equal(checkFor(report, 'Config file').status, 'info', 'a file that was never needed is not a fault');
    assert.deepEqual(
      report.sections.map((section) => section.title),
      ['Configuration', 'Credential storage', 'Claude Code', 'Routers', 'Environment', 'Permanent mode'],
    );
  });
});

test('a missing Claude Code is a warning with installation guidance', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    const provider = stubProvider({
      detect: async () => ({ found: false, hint: 'Install it from https://claude.com/claude-code' }),
    });
    const report = await runDoctor({ service, credentials, provider });

    const check = checkFor(report, 'Claude Code detected');
    assert.equal(check.status, 'warn', 'RouterFlip still manages routers without Claude Code installed');
    assert.equal(check.detail, 'not found on PATH');
    assert.match(check.hint ?? '', /Install it from/);
    assert.equal(report.healthy, true, 'a warning must not be reported as an unhealthy machine');
  });
});

test('a detected executable is reported with its path and version', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    const report = await runDoctor({ service, credentials, provider: stubProvider() });
    const check = checkFor(report, 'Claude Code detected');
    assert.equal(check.status, 'ok');
    assert.equal(check.detail, '/usr/local/bin/claude (2.1.232)');
    assert.equal(check.hint, undefined);
  });
});

test('a settings file that cannot be read is a row, not an exception', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    const provider = stubProvider({
      inspect: () => {
        throw new RouterFlipError('PROVIDER_CONFIG_FAILED', 'settings.json is not valid JSON.');
      },
    });
    const report = await runDoctor({ service, credentials, provider });

    const check = checkFor(report, 'Settings file');
    assert.equal(check.status, 'fail');
    assert.match(check.detail ?? '', /not valid JSON/);
    assert.equal(report.healthy, false, 'an unreadable provider config is a real failure');
    assert.equal(report.counts.fail >= 1, true);
  });
});

test('routers are listed with the active one marked and their keys accounted for', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    await service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: TEST_KEY });
    await service.add({ name: 'Beta', baseUrl: 'b.example', apiKey: TEST_KEY });
    const report = await runDoctor({ service, credentials, provider: stubProvider() });

    assert.equal(report.routerCount, 2);
    assert.equal(report.activeRouter, 'Alpha');
    assert.equal(checkFor(report, 'Alpha (active)').status, 'ok');
    assert.equal(checkFor(report, 'Alpha (active)').detail, 'https://a.example');
    assert.equal(checkFor(report, 'Beta').status, 'ok');
    assert.equal(report.healthy, true);
  });
});

test('a router whose key has gone missing fails with a repair hint', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    const router = await service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: TEST_KEY });
    await credentials.remove(router.credentialRef);

    const report = await runDoctor({ service, credentials, provider: stubProvider() });
    const check = checkFor(report, 'Alpha (active)');
    assert.equal(check.status, 'fail');
    assert.match(check.detail ?? '', /no stored API key/);
    assert.match(check.hint ?? '', /routerflip edit Alpha/);
    assert.equal(report.healthy, false);
  });
});

test('a plain-http router is flagged without being called broken', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    await service.add({ name: 'Insecure', baseUrl: 'http://api.remote.example', apiKey: TEST_KEY });
    const report = await runDoctor({ service, credentials, provider: stubProvider() });
    const check = checkFor(report, 'Insecure (active)');
    assert.equal(check.status, 'warn');
    assert.match(check.detail ?? '', /plain http/);
  });
});

test('the encrypted-file fallback is reported as less secure than a keyring', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    const report = await runDoctor({ service, credentials, provider: stubProvider() });
    const check = checkFor(report, 'Backend');
    assert.equal(check.status, 'warn', 'the file backend works but is not an OS keyring');
    assert.match(check.hint ?? '', /encrypted file/);
  });
});

test('shell variables that would override RouterFlip are surfaced, masked', async () => {
  const saved = { url: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
  process.env.ANTHROPIC_BASE_URL = 'https://shell.example';
  process.env.ANTHROPIC_API_KEY = TEST_KEY;
  try {
    await withSandbox(async () => {
      const { service, credentials } = sandboxService();
      const report = await runDoctor({ service, credentials, provider: stubProvider() });

      assert.equal(checkFor(report, 'ANTHROPIC_BASE_URL').status, 'warn');
      assert.match(checkFor(report, 'ANTHROPIC_BASE_URL').hint ?? '', /overrides/);
      const key = checkFor(report, 'ANTHROPIC_API_KEY');
      assert.equal(key.status, 'warn');
      assert.match(key.detail ?? '', /set in your shell/);
      assert.equal(key.detail?.includes(TEST_KEY), false, 'a shell key is described, never printed');
      assert.equal(JSON.stringify(report).includes(TEST_KEY), false, 'the whole report is safe to paste into a bug report');
    });
  } finally {
    for (const [name, value] of [['ANTHROPIC_BASE_URL', saved.url], ['ANTHROPIC_API_KEY', saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('an existing permanent activation is described, including a lost restore point', async () => {
  await withSandbox(async (sandbox) => {
    const { service, credentials } = sandboxService();
    const router = await service.add({ name: 'Alpha', baseUrl: 'a.example', apiKey: TEST_KEY });
    saveState({
      ...loadState(),
      activation: {
        routerId: router.id,
        routerName: router.name,
        provider: 'claude-code',
        appliedAt: '2026-01-01T00:00:00.000Z',
        targetFile: sandbox.settingsFile,
        managedKeys: ['env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_API_KEY'],
        preexisting: { 'env.ANTHROPIC_BASE_URL': 'yes' },
        originBackup: `${sandbox.home}/backups/deleted-by-hand.json`,
      },
    });

    const report = await runDoctor({ service, credentials, provider: stubProvider() });
    assert.equal(checkFor(report, 'Permanent selection').status, 'ok');
    assert.match(checkFor(report, 'Permanent selection').detail ?? '', /Alpha/);
    assert.equal(checkFor(report, 'Managed settings').detail, 'env.ANTHROPIC_BASE_URL, env.ANTHROPIC_API_KEY');
    const restore = checkFor(report, 'Restore point');
    assert.equal(restore.status, 'warn', 'a missing backup means original values can no longer come back');
    assert.match(restore.hint ?? '', /cannot be restored/);
  });
});

test('an activation pointing at a deleted router is called out', async () => {
  await withSandbox(async (sandbox) => {
    const { service, credentials } = sandboxService();
    saveState({
      ...loadState(),
      activation: {
        routerId: 'gone-1',
        routerName: 'Gone',
        provider: 'claude-code',
        appliedAt: '2026-01-01T00:00:00.000Z',
        targetFile: sandbox.settingsFile,
        managedKeys: [],
        preexisting: {},
      },
    });
    const report = await runDoctor({ service, credentials, provider: stubProvider() });
    const check = checkFor(report, 'Permanent selection');
    assert.equal(check.status, 'warn');
    assert.match(check.hint ?? '', /no longer exists/);
    assert.equal(checkFor(report, 'Managed settings').detail, 'none');
  });
});

test('doctor never reports a permanent change it did not make', async () => {
  await withSandbox(async () => {
    const { service, credentials } = sandboxService();
    const report = await runDoctor({ service, credentials, provider: stubProvider() });
    const check = checkFor(report, 'Permanent selection');
    assert.equal(check.status, 'info');
    assert.match(check.detail ?? '', /has not changed any provider configuration/);
  });
});
