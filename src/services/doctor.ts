/**
 * `routerflip doctor` — read-only environment diagnosis.
 *
 * Nothing here writes, spawns anything destructive, or contacts the network, so
 * `doctor` is always safe to run and is the first thing to ask for in a bug
 * report. It reports *presence* of credentials, never values.
 */
import { version as nodeVersion } from 'node:process';
import { existsSync, fileMode } from '../core/fsx.ts';
import { claudeConfigDir, paths, routerFlipHome } from '../core/paths.ts';
import { checkUrl } from '../core/url.ts';
import { maskSecret } from '../core/mask.ts';
import { loadState } from '../core/store.ts';
import { AUTH_ENV_VARS } from '../core/schema.ts';
import { credentialRefOf, credentialRefsOf } from '../core/accounts.ts';
import type { RouterService } from '../core/routers.ts';
import type { Credentials } from '../credentials/index.ts';
import type { Provider } from '../providers/types.ts';
import { describeCause } from '../errors.ts';
import { logger } from '../logger.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail?: string;
  readonly hint?: string;
}

export interface DoctorSection {
  readonly title: string;
  readonly checks: readonly Check[];
}

export interface DoctorReport {
  readonly sections: readonly DoctorSection[];
  readonly counts: { readonly ok: number; readonly warn: number; readonly fail: number };
  readonly healthy: boolean;
  readonly routerCount: number;
  readonly activeRouter?: string;
}

export interface DoctorDeps {
  readonly service: RouterService;
  readonly credentials: Credentials;
  readonly provider: Provider;
}

const POSIX = process.platform !== 'win32';

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const { service, credentials, provider } = deps;
  const p = paths();
  const sections: DoctorSection[] = [];

  // ── Configuration ────────────────────────────────────────────────────────
  const configChecks: Check[] = [
    {
      label: 'Config file',
      status: existsSync(p.configFile) ? 'ok' : 'info',
      detail: existsSync(p.configFile) ? p.configFile : `${p.configFile} (not created yet)`,
    },
    { label: 'Home directory', status: existsSync(p.home) ? 'ok' : 'info', detail: routerFlipHome() },
    {
      label: 'Backups',
      status: 'info',
      detail: existsSync(p.backupsDir) ? p.backupsDir : `${p.backupsDir} (none yet)`,
    },
  ];
  if (POSIX && existsSync(p.configFile)) {
    const mode = fileMode(p.configFile);
    configChecks.push({
      label: 'Config permissions',
      status: mode === '600' ? 'ok' : 'warn',
      detail: mode ? `mode ${mode}` : 'unknown',
      ...(mode === '600' ? {} : { hint: `Run: chmod 600 ${p.configFile}` }),
    });
  }
  sections.push({ title: 'Configuration', checks: configChecks });

  // ── Credential storage ───────────────────────────────────────────────────
  const credentialChecks: Check[] = [];
  try {
    const resolved = await credentials.resolved();
    credentialChecks.push({
      label: 'Backend',
      status: resolved.store.secure ? 'ok' : 'warn',
      detail: `${resolved.store.label}${resolved.store.location ? ` — ${resolved.store.location}` : ''}`,
      ...(resolved.store.secure
        ? {}
        : { hint: 'Keys are in an encrypted file because no OS keyring was found. Install one for stronger protection.' }),
    });
    for (const item of resolved.rejected) {
      credentialChecks.push({ label: `Backend "${item.id}"`, status: 'info', detail: item.reason });
    }
  } catch (error) {
    credentialChecks.push({
      label: 'Backend',
      status: 'fail',
      detail: describeCause(error),
      hint: 'No credential storage is usable, so keys cannot be saved.',
    });
  }
  sections.push({ title: 'Credential storage', checks: credentialChecks });

  // ── Provider ─────────────────────────────────────────────────────────────
  const detection = await provider.detect();
  const providerChecks: Check[] = [
    {
      label: `${provider.label} detected`,
      status: detection.found ? 'ok' : 'warn',
      detail: detection.found
        ? `${detection.executable}${detection.version ? ` (${detection.version})` : ''}`
        : 'not found on PATH',
      ...(detection.found ? {} : { hint: detection.hint ?? 'Install Claude Code to use temporary mode.' }),
    },
  ];
  let snapshotDetail = 'not created yet';
  let snapshotStatus: CheckStatus = 'info';
  try {
    const snapshot = provider.inspect();
    if (snapshot.exists) {
      snapshotStatus = 'ok';
      const bits = [
        snapshot.baseUrl ? `base URL: ${snapshot.baseUrl}` : 'no base URL set',
        snapshot.hasAuth ? 'auth configured' : 'no auth configured',
        `${snapshot.preservedKeys.length} unrelated setting(s) preserved`,
      ];
      snapshotDetail = `${snapshot.file} — ${bits.join(', ')}`;
    } else {
      snapshotDetail = `${snapshot.file} (not created yet)`;
    }
  } catch (error) {
    snapshotStatus = 'fail';
    snapshotDetail = describeCause(error);
  }
  providerChecks.push({ label: 'Settings file', status: snapshotStatus, detail: snapshotDetail });
  providerChecks.push({ label: 'Config directory', status: 'info', detail: claudeConfigDir() });
  providerChecks.push({ label: 'Mechanism', status: 'info', detail: provider.mechanism });
  sections.push({ title: provider.label, checks: providerChecks });

  // ── Routers ──────────────────────────────────────────────────────────────
  const routerChecks: Check[] = [];
  const routers = service.list();
  if (routers.length === 0) {
    routerChecks.push({
      label: 'Routers',
      status: 'info',
      detail: 'none configured',
      hint: 'Add one with `routerflip add`.',
    });
  } else {
    // Every account's ref, in one batch: a router's own ref is no longer the only
    // credential it can have, and after the first account is deleted it may hold
    // none at all.
    const presence = await credentials.presence(routers.flatMap((router) => [...credentialRefsOf(router)]));
    for (const router of routers) {
      const hasKey = presence.get(credentialRefOf(router)) === true;
      const url = checkUrl(router.baseUrl);
      const problems: string[] = [];
      // A router with no accounts has no key by definition; saying both would be noise.
      if (router.accounts.length === 0) problems.push('no accounts');
      else if (!hasKey) problems.push('no stored API key');
      const keyless = router.accounts.filter((account) => presence.get(account.credentialRef) !== true).length;
      if (router.accounts.length > 1 && keyless > 0) {
        problems.push(`${keyless} of ${router.accounts.length} accounts have no stored key`);
      }
      if (!url.ok) problems.push(url.error);
      else if (url.value.isInsecure) problems.push('uses plain http://');
      const active = service.activeId === router.id ? ' (active)' : '';
      const broken = router.accounts.length === 0 || !hasKey || !url.ok;
      routerChecks.push({
        label: `${router.name}${active}`,
        status: broken ? 'fail' : problems.length > 0 ? 'warn' : 'ok',
        detail: problems.length > 0 ? `${router.baseUrl} — ${problems.join('; ')}` : router.baseUrl,
        ...(router.accounts.length === 0
          ? { hint: `Add an account with \`routerflip accounts ${router.name} add\`.` }
          : hasKey
            ? {}
            : { hint: `Run \`routerflip edit ${router.name}\` to store its key.` }),
      });
    }
  }
  sections.push({ title: 'Routers', checks: routerChecks });

  // ── Environment ──────────────────────────────────────────────────────────
  const environmentChecks: Check[] = [];
  const baseUrlEnv = process.env.ANTHROPIC_BASE_URL;
  if (baseUrlEnv) {
    environmentChecks.push({
      label: 'ANTHROPIC_BASE_URL',
      status: 'warn',
      detail: baseUrlEnv,
      hint: 'Set in your shell — it overrides whatever RouterFlip writes permanently.',
    });
  }
  for (const name of AUTH_ENV_VARS) {
    const value = process.env[name];
    if (value) {
      environmentChecks.push({
        label: name,
        status: 'warn',
        // Presence only. The value is masked, never printed.
        detail: `set in your shell (${maskSecret(value)})`,
        hint: 'A shell variable wins over settings.json. Unset it if RouterFlip’s choice seems ignored.',
      });
    }
  }
  for (const name of ['CLAUDE_CONFIG_DIR', 'ROUTERFLIP_HOME'] as const) {
    if (process.env[name]) {
      environmentChecks.push({ label: name, status: 'info', detail: process.env[name] ?? '' });
    }
  }
  // Only reported when something is actually being written, so "where is the log?"
  // is answerable from the same command that asks the question.
  if (logger.logFile) {
    environmentChecks.push({ label: 'Debug log', status: 'info', detail: logger.logFile });
  }
  environmentChecks.push({ label: 'Node.js', status: 'ok', detail: nodeVersion });
  environmentChecks.push({ label: 'Platform', status: 'info', detail: `${process.platform} ${process.arch}` });
  sections.push({ title: 'Environment', checks: environmentChecks });

  // ── Permanent activation ─────────────────────────────────────────────────
  const state = loadState();
  const activationChecks: Check[] = [];
  if (state.activation) {
    const activation = state.activation;
    const stillExists = service.find(activation.routerId) !== undefined;
    activationChecks.push({
      label: 'Permanent selection',
      status: stillExists ? 'ok' : 'warn',
      detail: `${activation.routerName} → ${activation.targetFile} (applied ${activation.appliedAt})`,
      ...(stillExists ? {} : { hint: 'That router no longer exists. Run `routerflip use --permanent` to fix it.' }),
    });
    activationChecks.push({
      label: 'Managed settings',
      status: 'info',
      detail: activation.managedKeys.join(', ') || 'none',
    });
    if (activation.originBackup) {
      activationChecks.push({
        label: 'Restore point',
        status: existsSync(activation.originBackup) ? 'ok' : 'warn',
        detail: activation.originBackup,
        ...(existsSync(activation.originBackup)
          ? {}
          : { hint: 'The pre-RouterFlip backup is gone, so original values cannot be restored automatically.' }),
      });
    }
  } else {
    activationChecks.push({
      label: 'Permanent selection',
      status: 'info',
      detail: 'none — RouterFlip has not changed any provider configuration',
    });
  }
  sections.push({ title: 'Permanent mode', checks: activationChecks });

  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const section of sections) {
    for (const check of section.checks) {
      if (check.status === 'ok') counts.ok += 1;
      else if (check.status === 'warn') counts.warn += 1;
      else if (check.status === 'fail') counts.fail += 1;
    }
  }

  const activeRouter = service.activeId ? service.find(service.activeId)?.name : undefined;
  return {
    sections,
    counts,
    healthy: counts.fail === 0,
    routerCount: routers.length,
    ...(activeRouter ? { activeRouter } : {}),
  };
}
