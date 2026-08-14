/**
 * Shared test scaffolding.
 *
 * Every test that touches disk runs inside a throwaway sandbox: both roots
 * RouterFlip understands (`ROUTERFLIP_HOME`, `CLAUDE_CONFIG_DIR`) are pointed at
 * fresh temp directories and restored afterwards, so a test run can never read or
 * modify the developer's real configuration — and two tests can never see each
 * other's state.
 *
 * Nothing here needs a real API key, a network connection, or an installed Claude
 * Code: credentials go to the encrypted-file backend inside the sandbox, `fetch`
 * is stubbed per test, and process spawning is replaced by `fakeSpawn`.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { Credentials } from '../src/credentials/index.ts';
import { RouterService } from '../src/core/routers.ts';
import type { Router } from '../src/core/schema.ts';

export interface Sandbox {
  readonly home: string;
  readonly claudeDir: string;
  readonly settingsFile: string;
}

const ENV_KEYS = ['ROUTERFLIP_HOME', 'CLAUDE_CONFIG_DIR'] as const;

/**
 * Runs `body` with both roots redirected into a fresh temp directory.
 * The sandbox is removed afterwards, even when the body throws.
 */
export async function withSandbox<T>(body: (sandbox: Sandbox) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'routerflip-test-'));
  const home = join(root, 'routerflip');
  const claudeDir = join(root, 'claude');
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);

  process.env.ROUTERFLIP_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    return await body({ home, claudeDir, settingsFile: join(claudeDir, 'settings.json') });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A service backed by the encrypted-file credential store. Chosen explicitly so
 * tests never prompt for keychain access or shell out to PowerShell/`secret-tool`.
 */
export function sandboxService(): { service: RouterService; credentials: Credentials } {
  const credentials = new Credentials('file');
  return { service: new RouterService(credentials), credentials };
}

/** A complete Router literal, so tests can vary just the field under test. */
export function makeRouter(overrides: Partial<Router> = {}): Router {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return {
    id: 'alpha-1',
    name: 'Alpha',
    baseUrl: 'https://api.alpha.example',
    credentialRef: 'routerflip-alpha-1',
    description: '',
    provider: 'claude-code',
    authEnvVar: 'ANTHROPIC_API_KEY',
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

/** A test key long enough to exercise the "reveal last 4" masking branch. */
export const TEST_KEY = 'sk-test-0123456789abcdef';

export interface FakeChild extends EventEmitter {
  readonly killed: NodeJS.Signals[];
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

/**
 * Records what would have been spawned and returns a child the caller can
 * finish on demand — no process is ever created.
 */
export function fakeSpawn(): {
  spawnFn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  calls: SpawnCall[];
  child(): FakeChild;
} {
  const calls: SpawnCall[] = [];
  let last: FakeChild | undefined;

  const spawnFn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    calls.push({ command, args: [...args], options });
    const killed: NodeJS.Signals[] = [];
    const child = Object.assign(new EventEmitter(), {
      killed,
      kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
        killed.push(signal);
        return true;
      },
    }) as FakeChild;
    last = child;
    return child as unknown as ChildProcess;
  };

  return {
    spawnFn,
    calls,
    child(): FakeChild {
      if (!last) throw new Error('fakeSpawn: nothing has been spawned yet');
      return last;
    },
  };
}

/** Minimal `fetch` stub: one canned response, with the request captured. */
export function fakeFetch(response: { status: number; body?: string }): {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  requests: { url: string; init: RequestInit }[];
} {
  const requests: { url: string; init: RequestInit }[] = [];
  return {
    requests,
    async fetchImpl(url, init) {
      requests.push({ url, init });
      return new Response(response.body ?? '{}', { status: response.status });
    },
  };
}

/** A `fetch` stub that fails the way Node does for an unresolvable host. */
export function failingFetch(code: string): (url: string, init: RequestInit) => Promise<Response> {
  return async () => {
    const error = new TypeError('fetch failed');
    (error as { cause?: unknown }).cause = Object.assign(new Error('lookup failed'), { code });
    throw error;
  };
}
