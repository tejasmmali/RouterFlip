/**
 * `routerflip use [name]` — pick a gateway, then pick how long the choice lasts.
 *
 * The two modes are deliberately very different animals:
 *
 *   temporary — spawns Claude Code with an environment built in memory. Nothing
 *               on disk changes, and `process.env` of this process is never
 *               touched (spec §5).
 *   permanent — writes into Claude Code's own settings file, after a backup and
 *               an explicit confirmation, touching only RouterFlip's own keys
 *               (spec §6).
 */
import type { AppContext } from '../context.ts';
import type { Account, Router } from '../core/schema.ts';
import { updateState } from '../core/store.ts';
import { nowIso } from '../core/id.ts';
import { RouterFlipError } from '../errors.ts';
import { applyPermanent } from '../services/activation.ts';
import { launchRouter } from '../services/launcher.ts';
import type { PermanentStrategy } from '../providers/types.ts';
import { isInteractive } from '../ui/input.ts';
import { blank, heading, json, line, note, success, warning } from '../ui/output.ts';
import { select } from '../ui/prompts.ts';
import { theme } from '../ui/theme.ts';
import { routerDetailLines } from '../ui/views.ts';
import { confirmAction, pickAccount, pickRouter, routerJson, type CommandResult } from './shared.ts';

const STRATEGIES: readonly PermanentStrategy[] = ['env', 'helper'];

type Mode = 'temporary' | 'permanent' | 'cancel';

/** Environment already set in this shell would win over a settings file. */
function shadowingVars(ctx: AppContext, router: Router): string[] {
  return ctx.provider.envKeys(router).filter((name) => {
    const value = process.env[name];
    return typeof value === 'string' && value.length > 0;
  });
}

async function askMode(ctx: AppContext, router: Router, account?: Account): Promise<Mode> {
  if (ctx.flags.bool('temporary')) return 'temporary';
  if (ctx.flags.bool('permanent')) return 'permanent';

  if (!isInteractive()) {
    throw new RouterFlipError('BAD_USAGE', 'Choose how long this should apply: --temporary or --permanent.', {
      hint: `Example: routerflip use ${router.name} --temporary`,
      exitCode: 2,
    });
  }

  const view = await ctx.service.view(router, account);
  blank();
  for (const row of routerDetailLines(view)) line(row);
  // Which account only matters when the router has more than one; the mask above
  // already belongs to this account, so naming it is enough.
  if (account && router.accounts.length > 1) {
    const t = theme();
    blank();
    line(`  ${t.muted('Account')}`);
    line(`  ${t.text(account.name)}`);
  }
  blank();

  return select<Mode>({
    message: 'How should this router be used?',
    options: [
      {
        label: 'Temporary',
        value: 'temporary',
        detail: 'Launch Claude Code with this gateway for one session. Nothing is saved.',
      },
      {
        label: 'Permanent',
        value: 'permanent',
        detail: 'Write it into your Claude Code settings, with a backup first.',
      },
      { label: 'Cancel', value: 'cancel', detail: 'Leave everything as it is.' },
    ],
  });
}

/**
 * Temporary mode. Returns the child's exit code so the wrapper is transparent:
 * `routerflip use x --temporary` exits exactly as `claude` would have.
 *
 * `account` names the credential to launch with; omitted, the router's selected
 * account is used. The router still owns the base URL either way — an account
 * only ever contributes a key.
 */
export async function activateTemporary(
  ctx: AppContext,
  router: Router,
  args: readonly string[] = [],
  account?: Account,
): Promise<number> {
  const chosen = account ?? ctx.service.activeAccountOf(router);
  const apiKey = await ctx.service.apiKey(router, chosen);
  const t = theme();

  if (!ctx.json) {
    blank();
    note(`  ${t.accent('Temporary')} ${t.muted('— this affects the launched process only.')}`);
    note(`  ${t.muted('Router')}   ${t.text(router.name)}`);
    // Named only when there was a choice to make, so a single-account setup reads
    // exactly as it did before accounts existed.
    if (chosen && router.accounts.length > 1) note(`  ${t.muted('Account')}  ${t.text(chosen.name)}`);
    note(`  ${t.muted('Base URL')} ${t.dim(router.baseUrl)}`);
    note(`  ${t.muted('Auth via')} ${t.dim(router.authEnvVar)}`);
    blank();
  }

  // Recorded for `status` only. This is RouterFlip's own state file; no provider
  // configuration and no environment outside the child is involved.
  updateState((state) => ({
    ...state,
    lastTemporaryRouterId: router.id,
    ...(chosen ? { lastTemporaryAccountId: chosen.id } : {}),
    lastTemporaryAt: nowIso(),
  }));

  const result = await launchRouter({
    router,
    apiKey,
    provider: ctx.provider,
    args,
  });
  return result.code;
}

/** Permanent mode. Confirms, backs up, writes only RouterFlip's own keys. */
export async function activatePermanent(ctx: AppContext, router: Router, account?: Account): Promise<CommandResult> {
  const chosen = account ?? ctx.service.activeAccountOf(router);
  const apiKey = await ctx.service.apiKey(router, chosen);
  const strategy = ctx.flags.choice<PermanentStrategy>('strategy', STRATEGIES);
  const snapshot = ctx.provider.inspect();
  const t = theme();

  const details = [
    `Target file: ${snapshot.file}`,
    `Sets: ${ctx.provider.envKeys(router).join(', ')}`,
    ...(chosen && router.accounts.length > 1 ? [`Account: ${chosen.name}`] : []),
    // Say plainly where the secret ends up, before anything is written.
    strategy === 'env' || ctx.provider.helperCommand?.(router, chosen) === undefined
      ? 'The API key is written into that file in plain text, because no credential helper is available.'
      : 'The API key stays in your OS credential store; the file only gets a command that fetches it.',
    snapshot.exists
      ? `A timestamped backup is written first. ${snapshot.preservedKeys.length} unrelated setting${snapshot.preservedKeys.length === 1 ? '' : 's'} will be preserved.`
      : 'The file does not exist yet and will be created.',
  ];
  const approved = await confirmAction(ctx, {
    message: `Make ${router.name} your permanent Claude Code gateway?`,
    details,
    confirmLabel: 'Apply',
  });
  if (!approved) {
    if (!ctx.json) note('  Nothing was changed.');
    return 0;
  }

  const outcome = applyPermanent({
    router,
    apiKey,
    provider: ctx.provider,
    ...(strategy ? { strategy } : {}),
    ...(chosen ? { account: chosen } : {}),
    backupRetention: ctx.config.settings.backupRetention,
  });
  // Selecting a router permanently selects the account it authenticated with, so
  // the two halves of the choice can never disagree afterwards.
  if (chosen) ctx.service.setActiveAccount(router.id, chosen.id);
  else ctx.service.setActive(router.id);

  const shadowed = shadowingVars(ctx, router);

  if (ctx.json) {
    const view = await ctx.service.view(router, chosen);
    json({
      ok: true,
      mode: 'permanent',
      router: routerJson(view),
      targetFile: outcome.result.targetFile,
      strategy: outcome.result.strategy,
      managedKeys: outcome.result.managedKeys,
      preservedKeys: outcome.result.preservedKeys,
      ...(outcome.result.backup ? { backup: outcome.result.backup } : {}),
      strategyDowngraded: outcome.strategyDowngraded,
      shadowedBy: shadowed,
    });
    return 0;
  }

  blank();
  success(`Claude Code now uses "${router.name}".`);
  blank();
  if (chosen && router.accounts.length > 1) {
    line(`  ${t.muted('Account')}`);
    line(`  ${t.text(chosen.name)}`);
    blank();
  }
  line(`  ${t.muted('Written to')}`);
  line(`  ${outcome.result.targetFile}`);
  blank();
  line(`  ${t.muted('Managed keys')}`);
  line(`  ${t.dim(outcome.result.managedKeys.join(', '))}`);
  if (outcome.result.backup) {
    blank();
    line(`  ${t.muted('Backup')}`);
    line(`  ${t.dim(outcome.result.backup)}`);
  }
  if (outcome.result.preservedKeys.length > 0) {
    blank();
    line(`  ${t.muted('Preserved untouched')}`);
    line(`  ${t.dim(outcome.result.preservedKeys.join(', '))}`);
  }
  blank();

  if (outcome.strategyDowngraded) {
    warning('The credential-helper strategy needs `routerflip` on your PATH, so the key was written into the settings file instead.');
    note(`  ${t.dim('Install RouterFlip globally (npm i -g routerflip) and re-run with --strategy helper to keep the key in your OS credential store.')}`);
    blank();
  } else if (outcome.result.strategy === 'env') {
    // Not a warning — it is the documented fallback — but the user should know
    // the key is now readable in that file.
    note(`  ${t.dim('The API key is stored in that file in plain text. Install RouterFlip on your PATH and re-apply to keep it in your OS credential store instead.')}`);
    blank();
  }
  if (shadowed.length > 0) {
    warning(`${shadowed.join(' and ')} ${shadowed.length === 1 ? 'is' : 'are'} already set in this shell and would override the saved settings.`);
    note(`  ${t.dim('Unset them, or open a new terminal, so Claude Code picks up the new gateway.')}`);
    blank();
  }
  note(`  ${t.dim('Undo at any time with `routerflip deactivate`.')}`);
  return 0;
}

export interface UseOutcome {
  readonly exitCode: number;
  /** True when a child process was launched and has already finished. */
  readonly launched: boolean;
}

/**
 * The `use` flow for a router that has already been chosen.
 *
 * `account` is passed by the dashboard, which has just had the user select one;
 * from the command line it is resolved here — `--account`, else the router's
 * selected account, asking only when there is a real choice and a terminal.
 */
export async function useRouter(ctx: AppContext, router: Router, account?: Account): Promise<UseOutcome> {
  if (router.accounts.length === 0) {
    throw new RouterFlipError('CREDENTIAL_MISSING', `"${router.name}" has no accounts, so there is no key to launch with.`, {
      hint: `Add one with \`routerflip accounts ${router.name} add\`.`,
    });
  }
  const chosen = account ?? (await pickAccount(ctx, router));
  const mode = await askMode(ctx, router, chosen);

  if (mode === 'cancel') {
    if (!ctx.json) note('  Cancelled. Nothing was changed.');
    return { exitCode: 0, launched: false };
  }
  if (mode === 'temporary') {
    return { exitCode: await activateTemporary(ctx, router, ctx.rest, chosen), launched: true };
  }
  const result = await activatePermanent(ctx, router, chosen);
  return { exitCode: typeof result === 'number' ? result : 0, launched: false };
}

export async function useCommand(ctx: AppContext): Promise<CommandResult> {
  const router = await pickRouter(ctx, 'Which router should Claude Code use?');
  return (await useRouter(ctx, router)).exitCode;
}
