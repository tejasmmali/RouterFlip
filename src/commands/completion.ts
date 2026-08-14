/**
 * `routerflip completion [--shell bash|zsh|fish|powershell]`.
 *
 * Prints a completion script to stdout for the user to source. Router names are
 * completed dynamically: each script shells out to `routerflip completion routers`,
 * which prints one name per line, so completions never go stale.
 */
import { RouterFlipError } from '../errors.ts';
import type { AppContext } from '../context.ts';
import { line, note } from '../ui/output.ts';
import { theme } from '../ui/theme.ts';
import type { CommandResult } from './shared.ts';

const SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;
type Shell = (typeof SHELLS)[number];

const COMMANDS =
  'add list use claude current status test edit delete deactivate doctor completion version help';
const ROUTER_COMMANDS = 'use test edit delete';
const GLOBAL_FLAGS =
  '--temporary --permanent --strategy --router --name --url --key --key-stdin --description --auth-env --path --timeout --all --yes --json --verbose --quiet --color --no-color --help --version';

/** Best guess from the environment, so `routerflip completion` alone works. */
function detectShell(): Shell {
  const fromEnv = process.env.SHELL ?? process.env.ComSpec ?? '';
  const name = fromEnv.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (name.includes('zsh')) return 'zsh';
  if (name.includes('fish')) return 'fish';
  if (name.includes('bash')) return 'bash';
  if (process.env.PSModulePath) return 'powershell';
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

function bashScript(): string {
  return [
    '# routerflip bash completion',
    '_routerflip_complete() {',
    '  local cur prev',
    '  cur="\${COMP_WORDS[COMP_CWORD]}"',
    '  prev="\${COMP_WORDS[COMP_CWORD-1]}"',
    `  case "\$prev" in`,
    `    ${ROUTER_COMMANDS.split(' ').join('|')}|-r|--router)`,
    '      local names',
    '      names="$(routerflip completion routers 2>/dev/null)"',
    '      COMPREPLY=( $(compgen -W "$names" -- "$cur") )',
    '      return 0',
    '      ;;',
    '    --shell)',
    `      COMPREPLY=( \$(compgen -W "${SHELLS.join(' ')}" -- "\$cur") )`,
    '      return 0',
    '      ;;',
    '    --color)',
    '      COMPREPLY=( $(compgen -W "auto always never" -- "$cur") )',
    '      return 0',
    '      ;;',
    '    --strategy)',
    '      COMPREPLY=( $(compgen -W "env helper" -- "$cur") )',
    '      return 0',
    '      ;;',
    '  esac',
    '  if [[ "$cur" == -* ]]; then',
    `    COMPREPLY=( \$(compgen -W "${GLOBAL_FLAGS}" -- "\$cur") )`,
    '  else',
    `    COMPREPLY=( \$(compgen -W "${COMMANDS}" -- "\$cur") )`,
    '  fi',
    '}',
    'complete -F _routerflip_complete routerflip rflip',
  ].join('\n');
}

function zshScript(): string {
  return [
    '#compdef routerflip rflip',
    '# routerflip zsh completion',
    '_routerflip() {',
    '  local -a commands routers',
    `  commands=(${COMMANDS})`,
    '  if (( CURRENT == 2 )); then',
    "    _describe 'command' commands",
    '    return',
    '  fi',
    '  case "${words[2]}" in',
    `    ${ROUTER_COMMANDS.split(' ').join('|')})`,
    '      routers=(${(f)"$(routerflip completion routers 2>/dev/null)"})',
    "      _describe 'router' routers",
    '      ;;',
    '  esac',
    '}',
    'compdef _routerflip routerflip rflip',
  ].join('\n');
}

function fishScript(): string {
  const names = 'routerflip completion routers';
  return [
    '# routerflip fish completion',
    'complete -c routerflip -f',
    `complete -c routerflip -n __fish_use_subcommand -a "${COMMANDS}"`,
    `complete -c routerflip -n "__fish_seen_subcommand_from ${ROUTER_COMMANDS}" -a "(${names})"`,
    'complete -c routerflip -s t -l temporary -d "Use for one session only"',
    'complete -c routerflip -s p -l permanent -d "Write into Claude Code settings"',
    'complete -c routerflip -s y -l yes -d "Skip confirmations"',
    'complete -c routerflip -s j -l json -d "Machine-readable output"',
    'complete -c routerflip -l strategy -a "env helper" -d "How permanent mode stores the key"',
    'complete -c routerflip -l color -a "auto always never" -d "Colour mode"',
    `complete -c routerflip -l shell -a "${SHELLS.join(' ')}" -d "Completion shell"`,
    'complete -c rflip -w routerflip',
  ].join('\n');
}

function powershellScript(): string {
  return [
    '# routerflip PowerShell completion',
    '# Add to your profile:  routerflip completion --shell powershell | Out-String | Invoke-Expression',
    'Register-ArgumentCompleter -Native -CommandName routerflip,rflip -ScriptBlock {',
    '  param($wordToComplete, $commandAst, $cursorPosition)',
    `  $commands = @(${COMMANDS.split(' ').map((name) => `'${name}'`).join(',')})`,
    `  $routerCommands = @(${ROUTER_COMMANDS.split(' ').map((name) => `'${name}'`).join(',')})`,
    '  $tokens = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })',
    '  $verb = if ($tokens.Count -ge 1) { $tokens[0] } else { $null }',
    '  $candidates = if ($verb -and ($routerCommands -contains $verb)) {',
    '    try { @(& routerflip completion routers) } catch { @() }',
    '  } elseif ($verb -and -not $wordToComplete.StartsWith("-")) {',
    '    @()',
    '  } else {',
    '    $commands',
    '  }',
    '  $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {',
    '    [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)',
    '  }',
    '}',
  ].join('\n');
}

const SCRIPTS: Readonly<Record<Shell, () => string>> = {
  bash: bashScript,
  zsh: zshScript,
  fish: fishScript,
  powershell: powershellScript,
};

const INSTALL_HINT: Readonly<Record<Shell, string>> = {
  bash: 'Add to ~/.bashrc:  eval "$(routerflip completion --shell bash)"',
  zsh: 'Add to ~/.zshrc:  eval "$(routerflip completion --shell zsh)"',
  fish: 'Write it once:  routerflip completion --shell fish > ~/.config/fish/completions/routerflip.fish',
  powershell: 'Add to $PROFILE:  routerflip completion --shell powershell | Out-String | Invoke-Expression',
};

/**
 * `routerflip completion routers` — the dynamic half of every script above.
 * One name per line, nothing else, so `compgen` and friends can use it directly.
 */
function printRouterNames(ctx: AppContext): CommandResult {
  for (const router of ctx.service.list()) line(router.name);
  return 0;
}

export function completionCommand(ctx: AppContext): CommandResult {
  if (ctx.positionals[0] === 'routers') return printRouterNames(ctx);

  const requested = ctx.flags.choice('shell', SHELLS) ?? (ctx.positionals[0] as Shell | undefined);
  if (requested !== undefined && !(SHELLS as readonly string[]).includes(requested)) {
    throw new RouterFlipError('BAD_USAGE', `Unknown shell "${requested}".`, {
      hint: `Supported shells: ${SHELLS.join(', ')}.`,
      exitCode: 2,
    });
  }

  const shell = requested ?? detectShell();
  line(SCRIPTS[shell]());
  note('');
  note(`  ${theme().dim(INSTALL_HINT[shell])}`);
  return 0;
}
