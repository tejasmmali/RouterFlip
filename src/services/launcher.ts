/**
 * Temporary mode: run a provider CLI against one gateway, for one process.
 *
 * The guarantee this file exists to keep (spec §5) is that nothing outside the
 * child process changes. So:
 *   - `process.env` is never mutated; a *copy* is handed to the child;
 *   - no configuration file is read for writing or written at all;
 *   - stdio is inherited, so the child owns the terminal exactly as if the user
 *     had typed `claude` themselves — which also means RouterFlip must stop
 *     reading stdin and stop reacting to keyboard signals while it runs;
 *   - the child's exit code is propagated verbatim.
 *
 * `buildChildEnv` and `exitCodeFor` are exported separately from the spawn so
 * the interesting logic is unit-testable without launching anything.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { RouterFlipError, describeCause } from '../errors.ts';
import { logger } from '../logger.ts';
import { releaseStdin } from '../ui/input.ts';
import { releaseScreen } from '../ui/screen.ts';
import type { Router } from '../core/schema.ts';
import type { EnvDelta, Provider } from '../providers/types.ts';

const IS_WINDOWS = process.platform === 'win32';

export interface LaunchTarget {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface LaunchResult {
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
}

/** Minimal shape of `child_process.spawn`, so tests can substitute a fake. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Copies `base`, applies `delta`, and removes `remove`.
 *
 * On Windows environment names are case-insensitive, so removal has to compare
 * case-insensitively or a stale `Anthropic_Api_Key` could outrank our value.
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  delta: EnvDelta,
  remove: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const drop = new Set([...remove, ...Object.keys(delta)].map((name) => (IS_WINDOWS ? name.toLowerCase() : name)));
  for (const name of Object.keys(env)) {
    if (drop.has(IS_WINDOWS ? name.toLowerCase() : name)) delete env[name];
  }
  return { ...env, ...delta };
}

/**
 * Windows cannot `CreateProcess` a `.cmd`/`.bat` file, so Node throws `EINVAL`
 * for one since the CVE-2024-27980 fix — and an npm global install of Claude
 * Code is exactly that: a `claude.cmd` shim next to `claude.ps1`. The fix is not
 * `shell: true`, which would hand a single built string to whatever `ComSpec`
 * points at; instead we invoke the interpreter ourselves with
 * `windowsVerbatimArguments`, so the quoting below is the *only* quoting applied
 * and Node adds none of its own.
 *
 * `cmd /d /s /c "…"` is the documented shape: `/d` skips AutoRun scripts, and
 * `/s` with the whole command wrapped in one extra pair of quotes makes cmd strip
 * just that pair and treat everything between literally. Note that `%VAR%` inside
 * an argument is still expanded by cmd — unavoidable when the interpreter is cmd,
 * and identical to what the user would get typing the same line themselves.
 */
const WINDOWS_BATCH = /\.(?:cmd|bat)$/i;

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export interface SpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  /** True when the arguments are already quoted and Node must not re-quote. */
  readonly verbatim: boolean;
}

/** How `launch` will actually invoke a target. Exported for tests. */
export function spawnPlan(executable: string, args: readonly string[]): SpawnPlan {
  if (!IS_WINDOWS || !WINDOWS_BATCH.test(executable)) {
    return { command: executable, args: [...args], verbatim: false };
  }
  const command = [executable, ...args].map(quoteForCmd).join(' ');
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${command}"`],
    verbatim: true,
  };
}

/**
 * Signal policy — the part that has to be got right for the terminal to survive.
 *
 * The signals a terminal generates from a keystroke (Ctrl+C, Ctrl+Break, Ctrl+\)
 * are delivered by the OS to *every* process sharing that terminal, the child
 * included: on POSIX to the whole foreground process group, on Windows to every
 * process attached to the console. Forwarding them a second time is not neutral.
 *
 *   - On POSIX the child would receive two SIGINTs for one Ctrl+C, so Claude
 *     Code's "press Ctrl+C twice to exit" fires on a single press.
 *   - On Windows there are no signals to forward at all: `child.kill('SIGINT')`
 *     is `TerminateProcess`. When Claude Code is an npm `.cmd` shim the child is
 *     `cmd.exe`, and killing it does *not* take Claude Code with it — RouterFlip
 *     then sees `close`, exits, and the shell prints a prompt while an orphaned
 *     Claude Code is still alive, still in raw mode, still reading the same
 *     console. Two readers on one console input queue split escape sequences
 *     between them, which is exactly how fragments of the focus and mouse
 *     reports Claude Code enabled end up typed into its own input box.
 *
 * So those signals get a handler that does nothing: the parent must not die (the
 * child owns the terminal and decides when we are finished) and must not kill.
 * A signal that the terminal did *not* generate — a `kill` aimed at RouterFlip
 * alone — never reached the child, so that one is forwarded.
 */
const IGNORED_SIGNALS: readonly NodeJS.Signals[] = IS_WINDOWS
  ? ['SIGINT', 'SIGBREAK']
  : ['SIGINT', 'SIGQUIT'];

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = IS_WINDOWS ? [] : ['SIGTERM', 'SIGHUP'];

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGTERM: 15,
  SIGBREAK: 21,
};

/** POSIX convention: a signalled child reports as 128 + signal number. */
export function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === 'number') return code;
  if (signal) return 128 + (SIGNAL_NUMBERS[signal] ?? 0);
  return 1;
}

function launchFailure(error: NodeJS.ErrnoException, executable: string): RouterFlipError {
  if (error.code === 'ENOENT') {
    return new RouterFlipError('LAUNCH_FAILED', `Could not start ${executable} — the executable was not found.`, {
      hint: 'Install Claude Code, or make sure it is on your PATH. Run `routerflip doctor` to check.',
      cause: error,
    });
  }
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return new RouterFlipError('LAUNCH_FAILED', `Not allowed to run ${executable}.`, {
      hint: 'Check the file permissions on the executable.',
      cause: error,
    });
  }
  return new RouterFlipError('LAUNCH_FAILED', `Could not start ${executable}.`, {
    hint: `Details: ${describeCause(error)}`,
    cause: error,
  });
}

/**
 * Spawns the target with inherited stdio and waits for it.
 *
 * Two handovers happen here, and both matter more than they look:
 *
 *   - **stdin.** Inherited stdio means one shared descriptor, so RouterFlip stops
 *     reading it entirely for as long as the child lives (`releaseStdin`).
 *   - **signals.** See the policy above: keyboard signals are ignored rather than
 *     forwarded, so the child is the only thing that reacts to Ctrl+C.
 *
 * The result is that `routerflip claude` is the same terminal session `claude`
 * would have had, with two environment variables added to the child.
 */
export function launch(target: LaunchTarget, spawnFn: SpawnFn = spawn): Promise<LaunchResult> {
  return new Promise<LaunchResult>((resolve, reject) => {
    const plan = spawnPlan(target.executable, target.args);
    const options: SpawnOptions = {
      stdio: 'inherit',
      env: target.env,
      shell: false, // never build a command string: no quoting or injection risk
      windowsHide: false,
      ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
      ...(target.cwd ? { cwd: target.cwd } : {}),
    };

    // Declared before the spawn so the handlers can be installed first: a Ctrl+C
    // in the window between spawn and registration would otherwise kill the
    // parent and orphan the child we just started.
    let child: ChildProcess | undefined;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const listen = (signal: NodeJS.Signals, handler: () => void): void => {
      try {
        process.on(signal, handler);
        handlers.set(signal, handler);
      } catch {
        /* this platform does not know that signal */
      }
    };
    for (const signal of IGNORED_SIGNALS) listen(signal, () => {});
    for (const signal of FORWARDED_SIGNALS) {
      listen(signal, () => {
        // The child may already be gone; a failed kill is not an error here.
        try {
          child?.kill(signal);
        } catch {
          /* ignore */
        }
      });
    }

    // Two handovers, in this order: the frame, then the keyboard.
    //
    // If the dashboard is up, the child would otherwise inherit its alternate
    // buffer — a buffer RouterFlip discards on exit, taking everything Claude Code
    // printed with it. Leaving it first puts the child on the real terminal. Both
    // calls are no-ops when nothing owns the terminal, so a plain
    // `routerflip claude` writes nothing and leaves fd 0 as the shell set it.
    releaseScreen();
    const reclaimStdin = releaseStdin();

    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();
      reclaimStdin();
    };

    try {
      child = spawnFn(plan.command, plan.args, options);
    } catch (error) {
      cleanup();
      reject(launchFailure(error as NodeJS.ErrnoException, target.executable));
      return;
    }

    let settled = false;
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(launchFailure(error as NodeJS.ErrnoException, target.executable));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      logger.debug(`child exited: code=${String(code)} signal=${String(signal)}`);
      resolve({ code: exitCodeFor(code, signal), signal });
    });
  });
}

export interface LaunchRouterOptions {
  readonly router: Router;
  readonly apiKey: string;
  readonly provider: Provider;
  readonly args?: readonly string[];
  /** Resolved executable. Pass to skip a second PATH lookup. */
  readonly executable?: string;
  readonly spawnFn?: SpawnFn;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

/** Detects the provider CLI, builds the child environment, and runs it. */
export async function launchRouter(options: LaunchRouterOptions): Promise<LaunchResult> {
  const { router, apiKey, provider } = options;
  let executable = options.executable;
  if (!executable) {
    const detection = await provider.detect();
    if (!detection.found || !detection.executable) {
      throw new RouterFlipError('LAUNCH_FAILED', `${provider.label} is not installed, or not on your PATH.`, {
        hint: detection.hint ?? 'Run `routerflip doctor` for details.',
      });
    }
    executable = detection.executable;
  }

  logger.protect(apiKey);
  const env = buildChildEnv(options.baseEnv ?? process.env, provider.envFor(router, apiKey), provider.conflicts(router));
  logger.debug(`launching ${executable} for router ${router.id} (temporary)`);
  return launch(
    {
      executable,
      args: options.args ?? [],
      env,
    },
    options.spawnFn ?? spawn,
  );
}
