/**
 * `routerflip status` — a one-screen answer to "what will Claude Code do now?".
 *
 * Shorter than `doctor`: no health verdicts, just the four facts that decide
 * behaviour — the selected router, the permanent activation, the environment
 * currently exported in this shell, and whether Claude Code was found.
 */
import type { AppContext } from '../context.ts';
import { currentActivation } from '../services/activation.ts';
import { blank, json, line, note } from '../ui/output.ts';
import { theme } from '../ui/theme.ts';
import { relativeTime } from '../ui/views.ts';
import { routerJson, type CommandResult } from './shared.ts';

/** Auth variables are reported as present/absent only — never their values. */
const WATCHED_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'CLAUDE_CONFIG_DIR',
] as const;

function envSummary(): { name: string; present: boolean; value?: string }[] {
  return WATCHED_ENV.map((name) => {
    const raw = process.env[name];
    const present = typeof raw === 'string' && raw.length > 0;
    // A base URL, model or config dir is not a secret; a key is only ever "set".
    const shareable = name !== 'ANTHROPIC_API_KEY' && name !== 'ANTHROPIC_AUTH_TOKEN';
    return { name, present, ...(present && shareable ? { value: raw } : {}) };
  });
}

export async function statusCommand(ctx: AppContext): Promise<CommandResult> {
  const t = theme();
  const activeId = ctx.service.activeId;
  const router = activeId === undefined ? undefined : ctx.service.find(activeId);
  const activation = currentActivation();
  const detection = await ctx.provider.detect();
  const env = envSummary();
  // The router owns the base URL but an account owns the key, so which account is
  // selected is part of "what will Claude Code do now?" — by name only, never a value.
  const account = router ? ctx.service.activeAccountOf(router) : undefined;

  if (ctx.json) {
    const view = router ? await ctx.service.view(router) : undefined;
    json({
      ok: true,
      routers: ctx.service.list().length,
      router: view ? routerJson(view) : null,
      account: account ? { id: account.id, name: account.name, ...(account.model ? { model: account.model } : {}) } : null,
      permanent: activation
        ? {
            router: activation.routerName,
            ...(activation.accountName ? { account: activation.accountName } : {}),
            targetFile: activation.targetFile,
            appliedAt: activation.appliedAt,
          }
        : null,
      provider: {
        id: ctx.provider.id,
        found: detection.found,
        ...(detection.executable ? { executable: detection.executable } : {}),
        ...(detection.version ? { version: detection.version } : {}),
      },
      environment: env,
    });
    return 0;
  }

  const field = (label: string, value: string): void => {
    line(`  ${t.muted(label.padEnd(12))}${value}`);
  };

  blank();
  line(t.bold(t.accent('  RouterFlip status')));
  blank();
  field('Routers', `${ctx.service.list().length}`);
  field('Selected', router ? t.text(router.name) : t.dim('none'));
  if (router) field('Base URL', t.dim(router.baseUrl));
  if (router) {
    const total = router.accounts.length;
    field(
      'Account',
      account
        ? `${t.text(account.name)}${total > 1 ? t.dim(` (of ${total})`) : ''}`
        : t.warning('none — this router has no accounts'),
    );
    // The list is the router's, the selection the account's, so both are worth a
    // word: "none" here means Claude Code's own default still decides.
    field(
      'Model',
      account?.model
        ? t.text(account.model)
        : t.dim(router.models.length > 0 ? 'none selected — provider default' : 'provider default'),
    );
  }
  field(
    'Permanent',
    activation
      ? `${t.success(activation.routerName)}${activation.accountName ? t.dim(` · ${activation.accountName}`) : ''} ${t.dim(`· ${relativeTime(activation.appliedAt)} · ${activation.targetFile}`)}`
      : t.dim('not applied'),
  );
  field(
    'Claude Code',
    detection.found
      ? `${t.success('found')} ${t.dim(detection.executable ?? '')}${detection.version ? t.dim(` (${detection.version})`) : ''}`
      : t.warning('not found on PATH'),
  );
  blank();

  line(`  ${t.muted('Environment in this shell')}`);
  for (const entry of env) {
    const state = entry.present ? t.success('set') : t.dim('unset');
    const extra = entry.value ? ` ${t.dim(entry.value)}` : '';
    line(`  ${t.dim(entry.name.padEnd(22))}${state}${extra}`);
  }
  blank();

  const shadowing = env.filter((entry) => entry.present && entry.name.startsWith('ANTHROPIC_'));
  if (activation && shadowing.length > 0) {
    note(`  ${t.warning('Note:')} ${t.dim('variables set in this shell take precedence over the saved settings file.')}`);
    blank();
  }
  if (!detection.found && detection.hint) {
    note(`  ${t.dim(detection.hint)}`);
    blank();
  }
  return 0;
}
