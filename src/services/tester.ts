/**
 * Connection tester.
 *
 * Four questions, answered in order, each one cheap and each one reported
 * separately so a failure says *where* it happened (spec §8):
 *
 *   1. is the base URL well formed?
 *   2. is the host reachable at all?
 *   3. does the configured test endpoint respond?
 *   4. does the gateway accept the credential?
 *
 * The endpoint is configurable per router (`testPath`) with a global default,
 * because no assumption should be made about a given gateway's API surface. The
 * transport is injectable so tests never touch the network, and no step detail
 * ever contains the key — outbound it goes in a header, inbound the response is
 * passed through `redact` before it is shown.
 */
import { logger } from '../logger.ts';
import { checkUrl, joinUrl } from '../core/url.ts';
import type { Router } from '../core/schema.ts';

export type StepStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface TestStep {
  readonly key: 'url' | 'reachable' | 'endpoint' | 'auth';
  readonly label: string;
  readonly status: StepStatus;
  readonly detail?: string;
  readonly latencyMs?: number;
}

export interface TestReport {
  readonly routerId: string;
  readonly routerName: string;
  readonly baseUrl: string;
  readonly endpoint: string;
  readonly steps: readonly TestStep[];
  readonly ok: boolean;
  readonly latencyMs?: number;
  readonly status?: number;
}

/** Subset of `fetch` the tester uses, so a test can pass a stub. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TestOptions {
  readonly apiKey: string;
  /** Overrides `router.testPath` and the config default. */
  readonly path?: string;
  /** Default test path from config. */
  readonly defaultPath?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  /** Called as each step settles, for live checklist rendering. */
  readonly onStep?: (step: TestStep) => void;
}

export function endpointFor(router: Router, options: { path?: string; defaultPath?: string } = {}): string {
  const path = options.path ?? router.testPath ?? options.defaultPath ?? '/v1/messages';
  return joinUrl(router.baseUrl, path);
}

/** Auth header shape follows the env var the gateway expects the key in. */
function authHeaders(router: Router, apiKey: string): Record<string, string> {
  if (router.authEnvVar === 'ANTHROPIC_AUTH_TOKEN') {
    return { authorization: `Bearer ${apiKey}` };
  }
  return { 'x-api-key': apiKey };
}

/** A deliberately tiny, cheap request: one token, one word. */
function probeBody(): string {
  return JSON.stringify({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });
}

function firstLine(text: string, limit = 160): string {
  const clean = logger.scrub(text).replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

async function timed<T>(body: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await body();
  return { value, ms: Date.now() - started };
}

/**
 * Runs the checklist. Never throws for a *test* failure — a failed connection is
 * a report, not an exception — so callers can render all four rows either way.
 */
export async function testRouter(router: Router, options: TestOptions): Promise<TestReport> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const endpoint = endpointFor(router, options);
  const steps: TestStep[] = [];
  logger.protect(options.apiKey);

  const push = (step: TestStep): TestStep => {
    steps.push(step);
    options.onStep?.(step);
    return step;
  };

  const report = (ok: boolean, extra: { latencyMs?: number; status?: number } = {}): TestReport => ({
    routerId: router.id,
    routerName: router.name,
    baseUrl: router.baseUrl,
    endpoint,
    steps,
    ok,
    ...(extra.latencyMs === undefined ? {} : { latencyMs: extra.latencyMs }),
    ...(extra.status === undefined ? {} : { status: extra.status }),
  });

  // 1 ── URL format
  const url = checkUrl(router.baseUrl);
  if (!url.ok) {
    push({ key: 'url', label: 'URL format', status: 'fail', detail: url.error });
    push({ key: 'reachable', label: 'Network reachable', status: 'skip' });
    push({ key: 'endpoint', label: 'Endpoint responding', status: 'skip' });
    push({ key: 'auth', label: 'Authentication accepted', status: 'skip' });
    return report(false);
  }
  push({
    key: 'url',
    label: 'URL format',
    status: url.value.isInsecure ? 'warn' : 'pass',
    ...(url.value.isInsecure ? { detail: 'Uses plain http:// — the key travels unencrypted.' } : {}),
  });

  // 2+3 ── one request answers both "reachable" and "endpoint responding"
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  let response: Response;
  let elapsed: number;
  try {
    const outcome = await timed(() =>
      fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'user-agent': 'routerflip',
          ...authHeaders(router, options.apiKey),
        },
        body: probeBody(),
        signal: controller.signal,
      }),
    );
    response = outcome.value;
    elapsed = outcome.ms;
  } catch (error) {
    clearTimeout(timer);
    const detail = describeNetworkError(error, timeoutMs);
    push({ key: 'reachable', label: 'Network reachable', status: 'fail', detail });
    push({ key: 'endpoint', label: 'Endpoint responding', status: 'skip' });
    push({ key: 'auth', label: 'Authentication accepted', status: 'skip' });
    return report(false);
  }
  clearTimeout(timer);

  push({ key: 'reachable', label: 'Network reachable', status: 'pass', detail: url.value.host, latencyMs: elapsed });

  const status = response.status;
  const body = await safeText(response);

  if (status >= 500) {
    push({
      key: 'endpoint',
      label: 'Endpoint responding',
      status: 'fail',
      detail: `HTTP ${status} from the gateway${body ? ` — ${firstLine(body)}` : ''}`,
      latencyMs: elapsed,
    });
    push({ key: 'auth', label: 'Authentication accepted', status: 'skip' });
    return report(false, { latencyMs: elapsed, status });
  }

  if (status === 404) {
    push({
      key: 'endpoint',
      label: 'Endpoint responding',
      status: 'warn',
      detail: `HTTP 404 at ${endpoint} — this gateway may use a different path. Set one with \`routerflip edit ${router.name}\`.`,
      latencyMs: elapsed,
    });
    push({ key: 'auth', label: 'Authentication accepted', status: 'skip', detail: 'Not checked: the test endpoint was not found.' });
    return report(false, { latencyMs: elapsed, status });
  }

  push({ key: 'endpoint', label: 'Endpoint responding', status: 'pass', detail: `HTTP ${status}`, latencyMs: elapsed });

  // 4 ── auth verdict
  if (status === 401 || status === 403) {
    push({
      key: 'auth',
      label: 'Authentication accepted',
      status: 'fail',
      detail: `The gateway rejected the credential (HTTP ${status}).${body ? ` ${firstLine(body)}` : ''}`,
    });
    return report(false, { latencyMs: elapsed, status });
  }
  if (status === 429) {
    push({
      key: 'auth',
      label: 'Authentication accepted',
      status: 'warn',
      detail: 'Credential accepted, but the gateway is rate limiting (HTTP 429).',
    });
    return report(true, { latencyMs: elapsed, status });
  }
  if (status >= 400) {
    push({
      key: 'auth',
      label: 'Authentication accepted',
      status: 'warn',
      detail: `Not rejected, but the probe request was refused (HTTP ${status}).${body ? ` ${firstLine(body)}` : ''}`,
    });
    return report(true, { latencyMs: elapsed, status });
  }

  push({ key: 'auth', label: 'Authentication accepted', status: 'pass', detail: `HTTP ${status}` });
  return report(true, { latencyMs: elapsed, status });
}

/** Turns a fetch rejection into something a human can act on. */
function describeNetworkError(error: unknown, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return `No response within ${timeoutMs}ms.`;
  const cause = (error as { cause?: NodeJS.ErrnoException } | undefined)?.cause;
  const code = cause?.code ?? (error as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Hostname could not be resolved. Check the URL and your DNS/network.';
    case 'ECONNREFUSED':
      return 'Connection refused. The host is reachable but nothing is listening on that port.';
    case 'ECONNRESET':
      return 'Connection reset by the remote host.';
    case 'ETIMEDOUT':
      return 'Connection timed out.';
    case 'CERT_HAS_EXPIRED':
      return 'The TLS certificate has expired.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'The TLS certificate is self-signed and could not be verified.';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'The TLS certificate could not be verified.';
    default:
      return logger.scrub(error instanceof Error ? error.message : String(error));
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2_000);
  } catch {
    return '';
  }
}
