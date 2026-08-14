/**
 * `routerflip help` and `routerflip version`.
 *
 * The help text is the tool's real documentation for most people, so it lists
 * every command with a one-line purpose, then the flags, then the four examples
 * that cover the workflows people actually use.
 */
import type { AppContext } from '../context.ts';
import { versionInfo } from '../version.ts';
import { blank, json, line } from '../ui/output.ts';
import { rule, table } from '../ui/box.ts';
import { theme } from '../ui/theme.ts';
import { terminalWidth } from '../ui/width.ts';
import { TAGLINE } from '../ui/views.ts';
import type { CommandResult } from './shared.ts';

interface Entry {
  readonly usage: string;
  readonly summary: string;
}

const COMMANDS: readonly Entry[] = [
  { usage: '(no command)', summary: 'Open the interactive dashboard.' },
  { usage: 'add', summary: 'Add a router profile.' },
  { usage: 'list', summary: 'List every configured router.' },
  { usage: 'use [name]', summary: 'Use a router temporarily or permanently.' },
  { usage: 'claude [args…]', summary: 'Run Claude Code through the current router.' },
  { usage: 'current', summary: 'Show the selected router.' },
  { usage: 'status', summary: 'Show routers, activation and environment.' },
  { usage: 'test [name]', summary: 'Check URL, network, endpoint and auth.' },
  { usage: 'edit [name]', summary: 'Change a router profile.' },
  { usage: 'delete [name]', summary: 'Delete a router and its stored key.' },
  { usage: 'deactivate', summary: 'Undo permanent mode and restore settings.' },
  { usage: 'doctor', summary: 'Diagnose configuration and environment.' },
  { usage: 'completion [--shell]', summary: 'Print a shell completion script.' },
  { usage: 'version', summary: 'Print the version.' },
  { usage: 'help', summary: 'Show this help.' },
];

const OPTIONS: readonly Entry[] = [
  { usage: '-t, --temporary', summary: 'With `use`: launch Claude Code for one session only.' },
  { usage: '-p, --permanent', summary: 'With `use`: write the choice into Claude Code settings.' },
  { usage: '--strategy <env|helper>', summary: 'How permanent mode stores the key.' },
  { usage: '-r, --router <name>', summary: 'Select a router without a prompt.' },
  { usage: '-n, --name <name>', summary: 'Router name (with `add`, or to rename with `edit`).' },
  { usage: '-u, --url <url>', summary: 'Gateway base URL.' },
  { usage: '--key <value>', summary: 'API key. Prefer --key-stdin.' },
  { usage: '--key-stdin', summary: 'Read the API key from stdin.' },
  { usage: '-d, --description <text>', summary: 'Free-text description.' },
  { usage: '--auth-env <var>', summary: 'ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.' },
  { usage: '--path <path>', summary: 'Health-check path used by `test`.' },
  { usage: '--timeout <ms>', summary: 'Health-check timeout.' },
  { usage: '--all', summary: 'With `test`: test every router.' },
  { usage: '-y, --yes', summary: 'Answer confirmations with yes.' },
  { usage: '-j, --json', summary: 'Machine-readable output.' },
  { usage: '-v, --verbose', summary: 'Technical detail in errors, plus a redacted log in ~/.routerflip.' },
  { usage: '--quiet', summary: 'Suppress narration on stderr.' },
  { usage: '--color <auto|always|never>', summary: 'Force colour on or off.' },
  { usage: '-h, --help / -V, --version', summary: 'This help / the version.' },
];

const EXAMPLES: readonly (readonly [string, string])[] = [
  ['printf %s "$KEY" | routerflip add --name AgentRouter --url https://api.agentrouter.example --key-stdin', 'add a gateway without putting the key in your shell history'],
  ['routerflip use AgentRouter --temporary', 'run Claude Code against it once, changing nothing'],
  ['routerflip use AgentRouter --permanent', 'make it the default, with a backup first'],
  ['routerflip test --all', 'check every gateway'],
];

function entryTable(entries: readonly Entry[], width: number): string[] {
  const usageWidth = Math.min(30, Math.max(...entries.map((entry) => entry.usage.length)) + 2);
  const rendered = table(
    [{ header: '', max: usageWidth }, { header: '', max: Math.max(24, width - usageWidth - 6) }],
    entries.map((entry) => [theme().accent(entry.usage), theme().muted(entry.summary)]),
  );
  return rendered.slice(1); // the header row is intentionally empty here
}

export function helpCommand(ctx: AppContext): CommandResult {
  const t = theme();
  const width = terminalWidth();
  const info = versionInfo();

  if (ctx.json) {
    json({
      ok: true,
      name: info.name,
      version: info.version,
      commands: COMMANDS.map((entry) => ({ usage: entry.usage, summary: entry.summary })),
      options: OPTIONS.map((entry) => ({ usage: entry.usage, summary: entry.summary })),
    });
    return 0;
  }

  blank();
  line(`  ${t.bold(t.accent('RouterFlip'))} ${t.dim(`v${info.version}`)}  ${t.muted(TAGLINE)}`);
  blank();
  line(`  ${t.muted('Usage')}`);
  line(`  ${t.text('routerflip')} ${t.dim('[command] [options]')}`);
  blank();
  line(`  ${t.muted('Commands')}`);
  line(rule(width));
  for (const row of entryTable(COMMANDS, width)) line(row);
  blank();
  line(`  ${t.muted('Options')}`);
  line(rule(width));
  for (const row of entryTable(OPTIONS, width)) line(row);
  blank();
  line(`  ${t.muted('Examples')}`);
  line(rule(width));
  for (const [command, explanation] of EXAMPLES) {
    line(`  ${t.text(command)}`);
    line(`    ${t.dim(explanation)}`);
  }
  blank();
  line(`  ${t.muted('API keys live in your OS credential store. RouterFlip sends nothing anywhere.')}`);
  blank();
  return 0;
}

export function versionCommand(ctx: AppContext): CommandResult {
  const info = versionInfo();
  if (ctx.json) {
    json({ ok: true, ...info });
    return 0;
  }
  line(`${info.name} ${info.version}`);
  line(theme().dim(`node ${info.node} · ${info.platform}`));
  return 0;
}
