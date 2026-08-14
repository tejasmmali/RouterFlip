/**
 * `routerflip edit [name]` — change a profile in place.
 *
 * The form is pre-filled with the current values, except the key: the editor is
 * seeded with the *mask*, and submitting it unchanged keeps the stored secret. The
 * real key is never written to the screen, not even in an edit flow.
 */
import { AUTH_ENV_VARS } from '../core/schema.ts';
import type { Router } from '../core/schema.ts';
import type { RouterPatch } from '../core/routers.ts';
import { checkUrl } from '../core/url.ts';
import { currentActivation } from '../services/activation.ts';
import { RouterFlipError } from '../errors.ts';
import type { AppContext } from '../context.ts';
import { isInteractive } from '../ui/input.ts';
import { blank, heading, json, line, note, success } from '../ui/output.ts';
import { password, text, KEEP_EXISTING } from '../ui/prompts.ts';
import { theme } from '../ui/theme.ts';
import { routerDetailLines } from '../ui/views.ts';
import { keyFromFlags, pickRouter, routerJson, type CommandResult } from './shared.ts';

/** A patch built purely from flags, for scripted edits. */
async function patchFromFlags(ctx: AppContext, router: Router): Promise<RouterPatch> {
  const patch: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    description?: string;
    authEnvVar?: (typeof AUTH_ENV_VARS)[number];
    testPath?: string;
  } = {};

  // `--name` doubles as the selector, so it only renames when the router was
  // identified some other way (a positional or `--router`).
  const explicitName = ctx.flags.str('name');
  const selectedByName = ctx.positionals[0] === undefined && ctx.flags.str('router') === undefined;
  if (explicitName !== undefined && !selectedByName) patch.name = explicitName;

  const url = ctx.flags.str('url');
  if (url !== undefined) patch.baseUrl = url;

  const key = await keyFromFlags(ctx);
  if (key !== undefined) patch.apiKey = key;

  const description = ctx.flags.str('description');
  if (description !== undefined) patch.description = description;

  const authEnvVar = ctx.flags.choice('auth-env', AUTH_ENV_VARS);
  if (authEnvVar !== undefined) patch.authEnvVar = authEnvVar;

  const path = ctx.flags.str('path');
  if (path !== undefined) patch.testPath = path;

  return patch;
}

async function patchFromForm(ctx: AppContext, router: Router): Promise<RouterPatch> {
  const view = await ctx.service.view(router);
  const t = theme();

  blank();
  heading(`  Edit ${router.name}`);
  blank();
  note(`  ${t.dim('Leave a field as it is to keep the current value.')}`);
  blank();

  const name = await text({
    message: 'Name',
    initial: router.name,
    validate: (value) => {
      try {
        ctx.service.assertNameAvailable(value, router.id);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : 'Invalid name.';
      }
    },
  });
  const baseUrl = await text({
    message: 'Base URL',
    initial: router.baseUrl,
    validate: (value) => {
      const checked = checkUrl(value);
      return checked.ok ? undefined : checked.error;
    },
  });
  const key = await password({
    message: 'API Key',
    ...(view.hasKey ? { existingMask: view.maskedKey } : {}),
    help: view.hasKey ? 'Press Enter to keep the stored key.' : 'No key is stored for this router yet.',
  });
  const description = await text({
    message: 'Description',
    initial: router.description,
    placeholder: 'optional',
    allowEmpty: true,
  });

  return {
    name,
    baseUrl,
    description,
    ...(key === KEEP_EXISTING ? {} : { apiKey: key }),
  };
}

function isEmptyPatch(patch: RouterPatch): boolean {
  return Object.keys(patch).length === 0;
}

export async function editCommand(ctx: AppContext, target?: Router): Promise<CommandResult> {
  const router = target ?? (await pickRouter(ctx, 'Edit which router?'));

  let patch = await patchFromFlags(ctx, router);
  if (isEmptyPatch(patch)) {
    if (!isInteractive()) {
      throw new RouterFlipError('BAD_USAGE', 'Nothing to change.', {
        hint: `Pass what to change, for example: routerflip edit ${router.name} --url https://api.example.com`,
        exitCode: 2,
      });
    }
    patch = await patchFromForm(ctx, router);
  }

  const updated = await ctx.service.update(router.id, patch);
  const view = await ctx.service.view(updated);

  if (ctx.json) {
    json({ ok: true, router: routerJson(view) });
    return 0;
  }

  blank();
  success(`Router "${updated.name}" updated.`);
  blank();
  for (const row of routerDetailLines(view)) line(row);
  blank();

  // A stale settings file is the one surprise an edit can cause.
  const activation = currentActivation();
  if (activation?.routerId === updated.id) {
    note(`  ${theme().dim(`Claude Code still has the previous values. Re-apply with \`routerflip use ${updated.name} --permanent\`.`)}`);
  }
  return 0;
}
