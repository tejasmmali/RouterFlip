/**
 * Child-process helpers.
 *
 * `shell: false` everywhere — RouterFlip never builds a command string, so
 * quoting rules and shell metacharacters can't turn a router name or an API key
 * into executable text. This is also why `FOO=bar command` shell syntax is never
 * used: environment is passed through the real process env.
 */
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: NodeJS.ErrnoException;
}

export interface RunOptions {
  /** Written to the child's stdin, then stdin is closed. */
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

/**
 * Runs a command to completion and captures its output. Never rejects: a
 * missing executable comes back as `spawnError` so callers can produce a
 * friendly message instead of leaking an ENOENT stack.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const { input, timeoutMs = 15_000, env, cwd } = options;
  return new Promise((resolve) => {
    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    };
    if (env) spawnOptions.env = env;
    if (cwd) spawnOptions.cwd = cwd;

    let child;
    try {
      child = spawn(command, [...args], spawnOptions);
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', spawnError: error as NodeJS.ErrnoException });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, signal: 'SIGKILL', stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      finish({ code: null, signal: null, stdout, stderr, spawnError: error as NodeJS.ErrnoException });
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, stdout, stderr });
    });

    if (child.stdin) {
      child.stdin.on('error', () => {
        /* the child may exit before reading stdin; not our problem to report */
      });
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    }
  });
}

/** True when the command exists and exits 0. Used for capability probes. */
export async function probe(command: string, args: readonly string[], timeoutMs = 5_000): Promise<boolean> {
  const result = await run(command, args, { timeoutMs });
  return !result.spawnError && result.code === 0;
}
