/**
 * `routerflip credential <router>` — the credential helper (spec §11).
 *
 * Not for humans: this is the command written into Claude Code's `apiKeyHelper`
 * so the key can stay in the OS credential store instead of sitting in a
 * plaintext settings file. Claude Code runs it and reads stdout.
 *
 * This is the only place in RouterFlip where a key is written to a stream, it is
 * written raw (the redacting `output` helpers would mangle it), nothing else is
 * printed, and the recipient is the provider process that asked for it.
 */
import { RouterFlipError } from '../errors.ts';
import type { AppContext } from '../context.ts';
import { currentActivation } from '../services/activation.ts';
import type { CommandResult } from './shared.ts';

export async function credentialCommand(ctx: AppContext): Promise<CommandResult> {
  // Falls back to the permanently activated router so a settings file written by
  // an older RouterFlip (or edited by hand) still works.
  const target = ctx.positionals[0] ?? ctx.flags.str('router') ?? currentActivation()?.routerId;
  if (target === undefined) {
    throw new RouterFlipError('BAD_USAGE', 'Which router? `credential` needs a router name or id.', {
      hint: 'This command is meant to be called by Claude Code, not by hand.',
      exitCode: 2,
    });
  }

  const router = ctx.service.resolve(target);
  // `--account` is written by the helper command permanent mode installs, so the
  // key served here is the one that was chosen then — not merely whichever
  // account happens to be selected now. Omitted, the selected account is used,
  // which is what a settings file written by an older RouterFlip asks for.
  const wanted = ctx.flags.str('account');
  const account = wanted === undefined ? undefined : ctx.service.resolveAccount(router, wanted);
  const key = await ctx.service.apiKey(router, account);
  process.stdout.write(`${key}\n`);
  return 0;
}
