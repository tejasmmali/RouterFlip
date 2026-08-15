/**
 * Command dispatch — the only place that knows the full command surface.
 *
 * Four responsibilities, in order: parse argv, build the context, run the right
 * command, and turn whatever went wrong into a friendly message plus an exit
 * code. Nothing here does any real work itself, and no command below it ever
 * calls `process.exit`, so a failure always gets the chance to be explained.
 */
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type Parsed } from './args.ts';
import { createContext, type AppContext } from './context.ts';
import { RouterFlipError, isCancelled } from './errors.ts';
import { logger } from './logger.ts';
import { isInteractive } from './ui/input.ts';
import { note, printError } from './ui/output.ts';
import { theme } from './ui/theme.ts';
import { addCommand } from './commands/add.ts';
import { accountsCommand } from './commands/accounts.ts';
import { completionCommand } from './commands/completion.ts';
import { credentialCommand } from './commands/credential.ts';
import { currentCommand } from './commands/current.ts';
import { dashboardCommand } from './commands/dashboard.ts';
import { deactivateCommand } from './commands/deactivate.ts';
import { deleteCommand } from './commands/delete.ts';
import { doctorCommand } from './commands/doctor.ts';
import { editCommand } from './commands/edit.ts';
import { helpCommand, versionCommand } from './commands/help.ts';
import { listCommand } from './commands/list.ts';
import { modelsCommand } from './commands/models.ts';
import { runCommand } from './commands/run.ts';
import { statusCommand } from './commands/status.ts';
import { testCommand } from './commands/test.ts';
import { useCommand } from './commands/use.ts';
import type { CommandResult } from './commands/shared.ts';

type Handler = (ctx: AppContext) => CommandResult | Promise<CommandResult>;

/**
 * Canonical names come first in this table; the aliases after them exist because
 * people reasonably guess `ls`, `rm` or `switch`.
 */
const HANDLERS: Readonly<Record<string, Handler>> = {
  add: (ctx) => addCommand(ctx),
  new: (ctx) => addCommand(ctx),
  list: listCommand,
  ls: listCommand,
  accounts: accountsCommand,
  account: accountsCommand,
  models: modelsCommand,
  model: modelsCommand,
  use: useCommand,
  switch: useCommand,
  claude: runCommand,
  run: runCommand,
  current: currentCommand,
  status: statusCommand,
  test: testCommand,
  check: testCommand,
  edit: (ctx) => editCommand(ctx),
  delete: (ctx) => deleteCommand(ctx),
  remove: (ctx) => deleteCommand(ctx),
  rm: (ctx) => deleteCommand(ctx),
  deactivate: deactivateCommand,
  doctor: doctorCommand,
  credential: credentialCommand,
  completion: completionCommand,
  version: versionCommand,
  help: helpCommand,
};

/** Levenshtein distance, capped in practice by the short command names. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = row;
  }
  return previous[b.length] ?? b.length;
}

/** "Unknown command" is more useful with a guess attached. */
function suggestion(command: string): string | undefined {
  const needle = command.toLowerCase();
  let best: { name: string; score: number } | undefined;
  for (const name of Object.keys(HANDLERS)) {
    const score = name.startsWith(needle) ? 0 : distance(needle, name);
    if (score <= 2 && (best === undefined || score < best.score)) best = { name, score };
  }
  return best?.name;
}

function unknownCommand(command: string): RouterFlipError {
  const guess = suggestion(command);
  return new RouterFlipError('UNKNOWN_COMMAND', `"${command}" is not a RouterFlip command.`, {
    hint: guess ? `Did you mean \`routerflip ${guess}\`? Run \`routerflip help\` for the full list.` : 'Run `routerflip help` to see the available commands.',
    exitCode: 2,
  });
}

async function dispatch(parsed: Parsed, ctx: AppContext): Promise<CommandResult> {
  // `--help` and `--version` win over any command, which is what people expect
  // from `routerflip use --help`.
  if (ctx.flags.bool('help')) return helpCommand(ctx);
  if (ctx.flags.bool('version')) return versionCommand(ctx);

  if (parsed.command === undefined) {
    // Bare `routerflip` is the dashboard, but only where there is a terminal to
    // draw it on: piped or redirected, the useful answer is the help text.
    if (ctx.json || isInteractive()) return dashboardCommand(ctx);
    return helpCommand(ctx);
  }

  const handler = HANDLERS[parsed.command.toLowerCase()];
  if (!handler) throw unknownCommand(parsed.command);
  logger.debug(`dispatch ${parsed.command}`);
  return handler(ctx);
}

/**
 * A closed pipe is not a failure: `routerflip list | head -1` legitimately hangs
 * up on us, and the default behaviour would be an unhandled EPIPE.
 */
function ignoreBrokenPipe(): void {
  const swallow = (error: NodeJS.ErrnoException): void => {
    if (error.code === 'EPIPE') return;
    throw error;
  };
  process.stdout.on('error', swallow);
  process.stderr.on('error', swallow);
}

/** Cancelling is a decision, not a failure: one calm line, exit code 130. */
function report(error: unknown): number {
  if (isCancelled(error)) {
    note(`  ${theme().dim('Cancelled.')}`);
    return 130;
  }
  printError(error);
  return error instanceof RouterFlipError ? error.exitCode : 1;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  ignoreBrokenPipe();

  let code: number;
  try {
    const parsed = parseArgs(argv);
    const result = await dispatch(parsed, createContext(parsed));
    code = typeof result === 'number' ? result : 0;
  } catch (error) {
    code = report(error);
  }

  // The exit code is *set*, never forced with process.exit(): a pending stdout
  // write (a long `list`, a completion script) must still be flushed.
  process.exitCode = code;
  return code;
}

/**
 * Running this file directly — `node src/cli.ts add`, or `node dist/cli.js` —
 * behaves like the installed binary. Importing it (the launcher, the tests) does
 * not, so `main` stays a plain function with no side effects at import time.
 */
if (process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
