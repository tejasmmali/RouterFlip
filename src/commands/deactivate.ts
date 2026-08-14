/**
 * `routerflip deactivate` — undo permanent mode.
 *
 * Restores what Claude Code's settings said before RouterFlip touched them, using
 * the origin backup taken at the first apply, and forgets the activation record.
 * Router profiles and stored keys are untouched.
 */
import type { AppContext } from '../context.ts';
import { clearPermanent, currentActivation } from '../services/activation.ts';
import { blank, json, line, note, success } from '../ui/output.ts';
import { theme } from '../ui/theme.ts';
import { confirmAction, type CommandResult } from './shared.ts';

export async function deactivateCommand(ctx: AppContext): Promise<CommandResult> {
  const activation = currentActivation();
  const t = theme();

  if (!activation) {
    if (ctx.json) {
      json({ ok: true, changed: false, reason: 'no permanent activation is recorded' });
      return 0;
    }
    blank();
    note('  Nothing to undo — RouterFlip has not applied a permanent gateway.');
    blank();
    return 0;
  }

  const approved = await confirmAction(ctx, {
    message: `Remove "${activation.routerName}" from your Claude Code settings?`,
    details: [
      `File: ${activation.targetFile}`,
      `Keys removed or restored: ${activation.managedKeys.join(', ')}`,
      'Your router profiles and stored keys are kept.',
    ],
    confirmLabel: 'Undo',
  });
  if (!approved) {
    if (!ctx.json) note('  Nothing was changed.');
    return 0;
  }

  const outcome = clearPermanent(ctx.provider);
  if (!outcome) {
    if (!ctx.json) note('  Nothing to undo.');
    return 0;
  }

  if (ctx.json) {
    json({
      ok: true,
      changed: outcome.result.changed,
      targetFile: outcome.result.targetFile,
      removedKeys: outcome.result.removedKeys,
      ...(outcome.result.restoredFrom ? { restoredFrom: outcome.result.restoredFrom } : {}),
    });
    return 0;
  }

  blank();
  success(`Claude Code no longer uses "${activation.routerName}".`);
  blank();
  line(`  ${t.muted('File')}`);
  line(`  ${outcome.result.targetFile}`);
  if (outcome.result.removedKeys.length > 0) {
    blank();
    line(`  ${t.muted('Reverted keys')}`);
    line(`  ${t.dim(outcome.result.removedKeys.join(', '))}`);
  }
  if (outcome.result.restoredFrom) {
    blank();
    line(`  ${t.muted('Restored from')}`);
    line(`  ${t.dim(outcome.result.restoredFrom)}`);
  }
  blank();
  note(`  ${t.dim('Open a new terminal, or unset ANTHROPIC_* variables, for the change to take effect everywhere.')}`);
  return 0;
}
