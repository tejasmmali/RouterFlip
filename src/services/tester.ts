/**
 * Connection tester.
 *
 * Five questions, answered in order, each one cheap and each one reported
 * separately so a failure says *where* it happened (spec §8):
 *
 *   1. is the base URL well formed?
 *   2. is the host reachable at all?
 *   3. does the gateway accept the credential?
 *   4. does the Messages endpoint answer?
 *   5. is the model this router would launch with actually available?
 *
 * Two requests, in that order, because the order is what makes the verdict
 * unambiguous. `GET /v1/models` needs no model and costs no tokens, so a 401/403
 * there really is the credential. Only once the credential is known good does the
 * `POST /v1/messages` probe run — and then a rejection is about the *model*, which
 * matters because relay gateways answer an unknown model with a bare `403` or a
 * `503`, statuses that would otherwise read as "bad key".
 *
 * The transport is injectable so tests never touch the network, and no step detail
 * ever contains the key — outbound it goes in a header, inbound the response is
 * passed through `scrub` before it is shown.
 */
import { logger } from '../logger.ts';
import { checkUrl, joinUrl } from '../core/url.ts';
import type { DiscoveredModel } from '../core/accounts.ts';
import type { Router } from '../core/schema.ts';

export type StepStatus = 'pass' | 'warn' | 'fail' | 'skip';

/** Why a run failed, for a one-word verdict the user can act on. */
export type FailureReason = 'url' | 'connection' | 'timeout' | 'auth' | 'not-found' | 'gateway' | 'model';

export interface TestStep {
  readonly key: 'url' | 'reachable' | 'auth' | 'endpoint' | 'model';
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
  /** Absent when the run succeeded. */
  readonly reason?: FailureReason;
  /** Model the probe actually used, once one was chosen. */
  readonly model?: string;
  /**
   * What the gateway said it serves, when it answered the listing at all.
   *
   * Absent means discovery was unavailable — a distinct thing from "listed
   * nothing", and never a reason to call the router unhealthy.
   */
  readonly models?: readonly DiscoveredModel[];
}

/** Subset of `fetch` the tester uses, so a test can pass a stub. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TestOptions {
  readonly apiKey: string;
  /** Overrides `router.testPath` and the config default for the Messages probe. */
  readonly path?: string;
  /** Default Messages path from config. */
  readonly defaultPath?: string;
  /**
   * Model to verify — the one this router/account would actually launch with.
   * When absent the probe borrows the first model the gateway lists, so a router
   * with no model configured is still exercised end to end.
   */
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  /** Called as each step settles, for live checklist rendering. */
  readonly onStep?: (step: TestStep) => void;
}

/** Model listing: no model to guess, no tokens spent, so it grades auth cleanly. */
const MODELS_PATH = '/v1/models';

/**
 * Claude Code's own request signature.
 *
 * Gateways gate on it — agentrouter.org answers `401 unauthorized client detected`
 * to any client that is not the Claude CLI — so a probe wearing RouterFlip's own
 * user-agent fails against a router that works perfectly when Claude Code runs.
 * This check exists to answer "will Claude Code reach this gateway?", so it asks
 * in Claude Code's own voice rather than inventing a client of its own.
 * ponytail: pinned version string; read it from the detected CLI if it ever drifts.
 */
const PROBE_HEADERS: Readonly<Record<string, string>> = {
  accept: 'application/json',
  'anthropic-version': '2023-06-01',
  'user-agent': 'claude-cli/2.1.233 (external, cli)',
  'x-app': 'cli',
};

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

/**
 * The smallest legitimate chat request: one token, one word, one *real* model.
 *
 * The model is never hard-coded. A pinned model id is what broke this check —
 * gateways that do not serve it refuse the request outright, which looked like a
 * dead router.
 */
function probeBody(model: string): string {
  return JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
}

function firstLine(text: string, limit = 160): string {
  const clean = logger.scrub(text).replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/**
 * Models a gateway lists, in the order it listed them.
 *
 * Both shapes seen in the wild are the same on the part that matters: Anthropic's
 * `{"data":[{"id":…,"display_name":…}]}` and the OpenAI-ish listing relays serve
 * (`{"data":[{"id":…,"owned_by":…}]}`) both key the model on `data[].id`, which is
 * the string Claude Code has to be given. A label is only kept when the gateway
 * offers one that actually differs from the id — gorouter and tabitoken echo the
 * id back as `display_name`, and storing that would be noise.
 */
export function parseModelList(body: string): DiscoveredModel[] {
  try {
    const parsed = JSON.parse(body) as { data?: unknown };
    if (!Array.isArray(parsed.data)) return [];
    const out: DiscoveredModel[] = [];
    for (const entry of parsed.data) {
      const row = entry as { id?: unknown; display_name?: unknown; name?: unknown };
      if (typeof row.id !== 'string') continue;
      const id = row.id.trim();
      if (id.length === 0) continue;
      const label = typeof row.display_name === 'string' ? row.display_name : typeof row.name === 'string' ? row.name : '';
      const name = label.trim();
      out.push(name.length > 0 && name !== id ? { id, name } : { id });
    }
    return out;
  } catch {
    return [];
  }
}

export interface ModelListing {
  readonly status: number;
  readonly body: string;
  readonly ms: number;
  /** Parsed on an HTTP 200 only; a gateway that refuses the listing offers none. */
  readonly models: readonly DiscoveredModel[];
}

/**
 * `GET /v1/models` — the one place RouterFlip asks a gateway what it serves.
 *
 * `testRouter` uses it to grade the credential and to borrow a real model, and the
 * Models screen uses it to refresh the list. Returns the failure instead of
 * throwing, because a gateway with no listing is a normal outcome here.
 */
export async function fetchModels(
  router: Router,
  options: { readonly apiKey: string; readonly timeoutMs?: number; readonly fetchImpl?: FetchLike },
): Promise<ModelListing | Error> {
  const url = checkUrl(router.baseUrl);
  if (!url.ok) return new Error(url.error);
  logger.protect(options.apiKey);
  const outcome = await request(
    options.fetchImpl ?? ((target, init) => fetch(target, init)),
    joinUrl(url.value.url, MODELS_PATH),
    { method: 'GET', headers: { ...PROBE_HEADERS, ...authHeaders(router, options.apiKey) } },
    options.timeoutMs ?? 15_000,
  );
  if (outcome instanceof Error) return outcome;
  return { ...outcome, models: outcome.status === 200 ? parseModelList(outcome.body) : [] };
}

interface Outcome {
  readonly status: number;
  readonly body: string;
  readonly ms: number;
}

/** One timed request. Returns the error rather than throwing, so callers grade it. */
async function request(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Outcome | Error> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const started = Date.now();
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return { status: response.status, body: await safeText(response), ms: Date.now() - started };
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the checklist. Never throws for a *test* failure — a failed connection is
 * a report, not an exception — so callers can render every row either way.
 */
export async function testRouter(router: Router, options: TestOptions): Promise<TestReport> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const endpoint = endpointFor(router, options);
  const steps: TestStep[] = [];
  logger.protect(options.apiKey);

  const push = (step: TestStep): void => {
    steps.push(step);
    options.onStep?.(step);
  };

  let model: string | undefined = options.model;
  let discovered: readonly DiscoveredModel[] | undefined;
  const report = (ok: boolean, extra: { latencyMs?: number; status?: number; reason?: FailureReason } = {}): TestReport => ({
    routerId: router.id,
    routerName: router.name,
    baseUrl: router.baseUrl,
    endpoint,
    steps,
    ok,
    ...(extra.latencyMs === undefined ? {} : { latencyMs: extra.latencyMs }),
    ...(extra.status === undefined ? {} : { status: extra.status }),
    ...(extra.reason === undefined ? {} : { reason: extra.reason }),
    ...(model === undefined ? {} : { model }),
    ...(discovered === undefined ? {} : { models: discovered }),
  });

  /** Fills the rows after `from` with "skip", so the checklist always has five. */
  const skipFrom = (from: TestStep['key'], detail?: string): void => {
    const rest: readonly (readonly [TestStep['key'], string])[] = [
      ['reachable', 'Network reachable'],
      ['auth', 'Authentication accepted'],
      ['endpoint', 'Endpoint responding'],
      ['model', 'Model available'],
    ];
    let seen = false;
    for (const [key, label] of rest) {
      if (key === from) seen = true;
      if (!seen) continue;
      push({ key, label, status: 'skip', ...(key === from && detail ? { detail } : {}) });
    }
  };

  // 1 ── URL format
  const url = checkUrl(router.baseUrl);
  if (!url.ok) {
    push({ key: 'url', label: 'URL format', status: 'fail', detail: url.error });
    skipFrom('reachable');
    return report(false, { reason: 'url' });
  }
  push({
    key: 'url',
    label: 'URL format',
    status: url.value.isInsecure ? 'warn' : 'pass',
    ...(url.value.isInsecure ? { detail: 'Uses plain http:// — the key travels unencrypted.' } : {}),
  });

  const headers = { ...PROBE_HEADERS, ...authHeaders(router, options.apiKey) };
  const send = (target: string, init: RequestInit): Promise<Outcome | Error> =>
    request(fetchImpl, target, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } }, timeoutMs);

  // 2+3 ── one model listing answers "reachable", "is the credential good" and
  // "what does this gateway serve" — the same request the Models screen refreshes
  // with, so discovery is never a second implementation.
  const listing = await fetchModels(router, {
    apiKey: options.apiKey,
    timeoutMs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (listing instanceof Error) {
    const timedOut = listing.name === 'AbortError' || listing.name === 'TimeoutError';
    push({ key: 'reachable', label: 'Network reachable', status: 'fail', detail: describeNetworkError(listing, timeoutMs) });
    skipFrom('auth');
    return report(false, { reason: timedOut ? 'timeout' : 'connection' });
  }
  push({ key: 'reachable', label: 'Network reachable', status: 'pass', detail: url.value.host, latencyMs: listing.ms });

  if (listing.status === 401 || listing.status === 403) {
    push({
      key: 'auth',
      label: 'Authentication accepted',
      status: 'fail',
      detail: `The gateway rejected the credential (HTTP ${listing.status}).${listing.body ? ` ${firstLine(listing.body)}` : ''}`,
      latencyMs: listing.ms,
    });
    skipFrom('endpoint');
    return report(false, { latencyMs: listing.ms, status: listing.status, reason: 'auth' });
  }
  if (listing.status >= 500) {
    push({
      key: 'auth',
      label: 'Authentication accepted',
      status: 'fail',
      detail: `HTTP ${listing.status} from the gateway${listing.body ? ` — ${firstLine(listing.body)}` : ''}`,
      latencyMs: listing.ms,
    });
    skipFrom('endpoint');
    return report(false, { latencyMs: listing.ms, status: listing.status, reason: 'gateway' });
  }

  // A gateway need not implement the listing; the chat probe below still judges it.
  if (listing.status === 200) discovered = listing.models;
  const available = listing.models.map((entry) => entry.id);
  push({
    key: 'auth',
    label: 'Authentication accepted',
    status: listing.status === 200 ? 'pass' : 'warn',
    detail:
      listing.status === 200
        ? `HTTP 200${available.length > 0 ? ` — ${available.length} model${available.length === 1 ? '' : 's'} offered` : ''}`
        : `HTTP ${listing.status} at ${MODELS_PATH}; judging the credential from the chat probe instead.`,
    latencyMs: listing.ms,
  });

  // 4+5 ── the smallest real chat request, with a model that actually exists
  model ??= available[0];
  if (model === undefined) {
    push({
      key: 'endpoint',
      label: 'Endpoint responding',
      status: 'warn',
      detail: `No model to probe with: ${MODELS_PATH} listed none. Add one with \`routerflip models ${router.name} add "<name>"\`.`,
    });
    push({ key: 'model', label: 'Model available', status: 'skip', detail: 'Not checked: no model is configured.' });
    return report(true, { latencyMs: listing.ms, status: listing.status });
  }

  const chat = await send(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: probeBody(model) });
  if (chat instanceof Error) {
    const timedOut = chat.name === 'AbortError' || chat.name === 'TimeoutError';
    push({ key: 'endpoint', label: 'Endpoint responding', status: 'fail', detail: describeNetworkError(chat, timeoutMs) });
    push({ key: 'model', label: 'Model available', status: 'skip' });
    return report(false, { reason: timedOut ? 'timeout' : 'connection' });
  }

  return gradeChat({ router, endpoint, model, chat, credentialKnownGood: listing.status === 200, push, report });
}

interface GradeInput {
  readonly router: Router;
  readonly endpoint: string;
  readonly model: string;
  readonly chat: Outcome;
  /** True once `/v1/models` returned 200 — then a refusal here is not the key. */
  readonly credentialKnownGood: boolean;
  readonly push: (step: TestStep) => void;
  readonly report: (ok: boolean, extra?: { latencyMs?: number; status?: number; reason?: FailureReason }) => TestReport;
}

/**
 * Verdict on the chat probe.
 *
 * The nonstandard shapes are the whole point. A relay that does not carry the
 * requested model answers with a bare `403` HTML page (openresty) or a `503`
 * naming the model — neither is Anthropic's `404 not_found_error`, and reading
 * either as "bad credential" is what marked working routers as broken.
 * ponytail: the 5xx case matches on the model id appearing in the body; a status
 * code alone cannot separate "model not carried" from "gateway is down".
 */
function gradeChat(input: GradeInput): TestReport {
  const { chat, model, endpoint, router, push, report } = input;
  const { status, ms } = chat;
  const tail = chat.body ? ` ${firstLine(chat.body)}` : '';
  const endpointOk = (detail: string): void =>
    push({ key: 'endpoint', label: 'Endpoint responding', status: 'pass', detail, latencyMs: ms });
  const mentionsModel = chat.body.includes(model);

  if (status === 404) {
    push({
      key: 'endpoint',
      label: 'Endpoint responding',
      status: 'fail',
      detail: `HTTP 404 at ${endpoint} — this gateway may use a different path. Set one with \`routerflip edit ${router.name}\`.`,
      latencyMs: ms,
    });
    push({ key: 'model', label: 'Model available', status: 'skip', detail: 'Not checked: the endpoint was not found.' });
    return report(false, { latencyMs: ms, status, reason: 'not-found' });
  }

  if (status === 401 || status === 403) {
    // The listing already proved the credential, so this is the model being refused.
    if (input.credentialKnownGood) {
      endpointOk(`HTTP ${status}`);
      push({
        key: 'model',
        label: 'Model available',
        status: 'fail',
        detail: `The gateway refused "${model}" (HTTP ${status}). Pick one it offers with \`routerflip models ${router.name}\`.${tail}`,
      });
      return report(false, { latencyMs: ms, status, reason: 'model' });
    }
    push({
      key: 'endpoint',
      label: 'Endpoint responding',
      status: 'fail',
      detail: `The gateway rejected the credential (HTTP ${status}).${tail}`,
      latencyMs: ms,
    });
    push({ key: 'model', label: 'Model available', status: 'skip' });
    return report(false, { latencyMs: ms, status, reason: 'auth' });
  }

  if (status >= 500) {
    if (mentionsModel) {
      endpointOk(`HTTP ${status}`);
      push({
        key: 'model',
        label: 'Model available',
        status: 'fail',
        detail: `The gateway has no capacity for "${model}" (HTTP ${status}).${tail}`,
      });
      return report(false, { latencyMs: ms, status, reason: 'model' });
    }
    push({
      key: 'endpoint',
      label: 'Endpoint responding',
      status: 'fail',
      detail: `HTTP ${status} from the gateway${tail}`,
      latencyMs: ms,
    });
    push({ key: 'model', label: 'Model available', status: 'skip' });
    return report(false, { latencyMs: ms, status, reason: 'gateway' });
  }

  endpointOk(`HTTP ${status}`);

  if (status === 429) {
    push({ key: 'model', label: 'Model available', status: 'warn', detail: 'Accepted, but the gateway is rate limiting (HTTP 429).' });
    return report(true, { latencyMs: ms, status });
  }
  if (status === 400 && /model/i.test(chat.body)) {
    push({
      key: 'model',
      label: 'Model available',
      status: 'fail',
      detail: `The gateway rejected "${model}" (HTTP 400).${tail}`,
    });
    return report(false, { latencyMs: ms, status, reason: 'model' });
  }
  if (status >= 400) {
    push({ key: 'model', label: 'Model available', status: 'warn', detail: `The probe request was refused (HTTP ${status}).${tail}` });
    return report(true, { latencyMs: ms, status });
  }

  push({ key: 'model', label: 'Model available', status: 'pass', detail: model });
  return report(true, { latencyMs: ms, status });
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
