/**
 * `routerflip add` — create a router profile.
 *
 * Works two ways on purpose: an interactive form for humans, and
 * `--name/--url/--key` (or `--key-stdin`) for scripts. Validation is identical in
 * both, because it lives in `RouterService`; the form only decides *when* to ask.
 */
import { AUTH_ENV_VARS, type AuthEnvVar } from '../core/schema.ts';
import { checkUrl } from '../core/url.ts';
import { RouterFlipError } from '../errors.ts';
import type { AppContext } from '../context.ts';
import type { Router } from '../core/schema.ts';
import { isInteractive } from '../ui/input.ts';
import { blank, heading, json, line, note, success } from '../ui/output.ts';
import { password, promptIntro, text, KEEP_EXISTING } from '../ui/prompts.ts';
import { terminalWidth } from '../ui/width.ts';
import { bannerLines, routerDetailLines } from '../ui/views.ts';
import { confirmAction, keyFromFlags, routerJson, type CommandResult } from './shared.ts';
import { runTest } from './test.ts';

/** Live validators, so the form rejects bad input before it is submitted. */
function nameValidator(ctx: AppContext): (value: string) => string | undefined {
  return (value) => {
    try {
      ctx.service.assertNameAvailable(value);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : 'Invalid name.';
    }
  };
}

function urlValidator(value: string): string | undefined {
  const checked = checkUrl(value);
  return checked.ok ? undefined : checked.error;
}

export interface AddOptions {
  /** Skip the "test this now?" question — used by the dashboard. */
  readonly quiet?: boolean;
}

/** The interactive form. Returns the created router. */
async function addInteractive(ctx: AppContext): Promise<Router> {
  const width = terminalWidth();
  for (const row of bannerLines(width)) line(row);
  blank();
  heading('  Add a router');
  blank();
  promptIntro('  The API key is stored in your operating system credential store, never in config.json.');
  blank();

  const name = await text({
    message: 'Name',
    placeholder: 'AgentRouter',
    validate: nameValidator(ctx),
    help: 'A short label you will recognise in the list.',
  });
  const baseUrl = await text({
    message: 'Base URL',
    placeholder: 'https://api.agentrouter.example',
    validate: urlValidator,
    help: 'The gateway origin. A trailing /v1 or /v1/messages is trimmed for you.',
  });
  const key = await password({ message: 'API Key' });
  const description = await text({
    message: 'Description',
    placeholder: 'optional',
    allowEmpty: true,
  });

  return ctx.service.add({
    name,
    baseUrl,
    apiKey: key === KEEP_EXISTING ? '' : key,
    description,
    ...authFrom(ctx),
    ...pathFrom(ctx),
  });
}

function authFrom(ctx: AppContext): { authEnvVar?: AuthEnvVar } {
  const chosen = ctx.flags.choice('auth-env', AUTH_ENV_VARS);
  return chosen ? { authEnvVar: chosen } : {};
}

function pathFrom(ctx: AppContext): { testPath?: string } {
  const path = ctx.flags.str('path');
  return path ? { testPath: path } : {};
}

export async function addCommand(ctx: AppContext, options: AddOptions = {}): Promise<CommandResult> {
  const name = ctx.flags.str('name') ?? ctx.positionals[0];
  const url = ctx.flags.str('url') ?? ctx.positionals[1];
  const key = await keyFromFlags(ctx);

  let router: Router;
  if (name !== undefined && url !== undefined && key !== undefined) {
    router = await ctx.service.add({
      name,
      baseUrl: url,
      apiKey: key,
      description: ctx.flags.str('description') ?? '',
      ...authFrom(ctx),
      ...pathFrom(ctx),
    });
  } else if (!isInteractive()) {
    throw new RouterFlipError('BAD_USAGE', 'Adding a router needs a name, a base URL and a key.', {
      hint: 'Example: routerflip add --name AgentRouter --url https://api.example.com --key-stdin',
      exitCode: 2,
    });
  } else {
    router = await addInteractive(ctx);
  }

  const view = await ctx.service.view(router);
  if (ctx.json) {
    json({ ok: true, router: routerJson(view) });
    return 0;
  }

  blank();
  success(`Router "${router.name}" added successfully.`);
  blank();
  for (const row of routerDetailLines(view)) line(row);
  blank();

  // Offer the check rather than performing it: `add` should not surprise anyone
  // with a network request, and a gateway may be provisioned minutes later.
  if (!options.quiet && !ctx.flags.bool('no-test') && isInteractive() && !ctx.assumeYes) {
    const wanted = await confirmAction(ctx, { message: 'Test this connection now?', confirmLabel: 'Test' });
    if (wanted) {
      blank();
      await runTest(ctx, router);
    }
  } else if (!ctx.flags.bool('no-test')) {
    note(`  Check it with \`routerflip test ${router.name}\`.`);
  }
  return 0;
}
