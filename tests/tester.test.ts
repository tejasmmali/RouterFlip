/**
 * Connection testing (spec §8 and §25: "invalid credentials", "invalid URLs").
 *
 * Every case here uses a stubbed transport: the suite never opens a socket and
 * never needs a real key. What is being pinned down is the part a user reads —
 * *which* of the four steps failed, whether the run is reported as ok, and that
 * no step detail ever carries the credential, even when a gateway echoes it back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointFor, testRouter, type TestReport, type TestStep } from '../src/services/tester.ts';
import { makeRouter, fakeFetch, failingFetch, TEST_KEY } from './helpers.ts';

function stepOf(report: TestReport, key: TestStep['key']): TestStep {
  const step = report.steps.find((candidate) => candidate.key === key);
  assert.ok(step, `expected a "${key}" step in the report`);
  return step;
}

function statuses(report: TestReport): Record<string, string> {
  return Object.fromEntries(report.steps.map((step) => [step.key, step.status]));
}

/** Runs the checklist against a canned HTTP status. */
async function probe(status: number, body?: string, router = makeRouter()) {
  const transport = fakeFetch({ status, ...(body === undefined ? {} : { body }) });
  const report = await testRouter(router, { apiKey: TEST_KEY, fetchImpl: transport.fetchImpl });
  return { report, requests: transport.requests };
}

test('a healthy gateway passes all four steps', async () => {
  const { report } = await probe(200, '{"id":"msg_1"}');
  assert.deepEqual(statuses(report), { url: 'pass', reachable: 'pass', endpoint: 'pass', auth: 'pass' });
  assert.equal(report.ok, true);
  assert.equal(report.status, 200);
  assert.equal(typeof report.latencyMs, 'number', 'a latency is reported alongside the verdict');
});

test('the probe is a POST to the configured endpoint with the key in a header', async () => {
  const { report, requests } = await probe(200);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url, 'https://api.alpha.example/v1/messages');
  assert.equal(report.endpoint, request.url);
  assert.equal(request.init.method, 'POST');
  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], TEST_KEY, 'the key goes in a header, never in the URL');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(request.url.includes(TEST_KEY), false);
});

test('a bearer-token router authenticates with Authorization instead', async () => {
  const { requests } = await probe(200, undefined, makeRouter({ authEnvVar: 'ANTHROPIC_AUTH_TOKEN' }));
  const headers = requests[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TEST_KEY}`);
  assert.equal(headers['x-api-key'], undefined);
});

test('a rejected credential fails the auth step and nothing earlier', async () => {
  for (const status of [401, 403]) {
    const { report } = await probe(status, '{"error":{"message":"invalid x-api-key"}}');
    assert.deepEqual(statuses(report), { url: 'pass', reachable: 'pass', endpoint: 'pass', auth: 'fail' });
    assert.equal(report.ok, false, `HTTP ${status} must not be reported as a working router`);
    assert.match(stepOf(report, 'auth').detail ?? '', /rejected the credential/);
  }
});

test('a 404 is a warning about the path, not a verdict on the key', async () => {
  const { report } = await probe(404, 'Not Found');
  assert.deepEqual(statuses(report), { url: 'pass', reachable: 'pass', endpoint: 'warn', auth: 'skip' });
  assert.equal(report.ok, false);
  // Spec §8: no assumption may be made about a gateway's exact API surface.
  assert.match(stepOf(report, 'endpoint').detail ?? '', /may use a different path/);
  assert.match(stepOf(report, 'auth').detail ?? '', /not found/);
});

test('a server error stops the checklist before the auth step', async () => {
  const { report } = await probe(502, 'bad gateway');
  assert.deepEqual(statuses(report), { url: 'pass', reachable: 'pass', endpoint: 'fail', auth: 'skip' });
  assert.equal(report.ok, false);
  assert.match(stepOf(report, 'endpoint').detail ?? '', /HTTP 502/);
});

test('rate limiting means the key works, so the router is usable', async () => {
  const { report } = await probe(429, '{"error":"rate_limit_error"}');
  assert.equal(stepOf(report, 'auth').status, 'warn');
  assert.equal(report.ok, true, 'a 429 proves the credential was accepted');
});

test('another 4xx is reported as a refused probe rather than a bad key', async () => {
  const { report } = await probe(400, '{"error":{"message":"model not supported"}}');
  assert.equal(stepOf(report, 'auth').status, 'warn');
  assert.equal(report.ok, true);
  assert.match(stepOf(report, 'auth').detail ?? '', /probe request was refused/);
});

test('an unresolvable host is explained in plain language', async () => {
  const report = await testRouter(makeRouter({ baseUrl: 'https://nope.invalid' }), {
    apiKey: TEST_KEY,
    fetchImpl: failingFetch('ENOTFOUND'),
  });
  assert.deepEqual(statuses(report), { url: 'pass', reachable: 'fail', endpoint: 'skip', auth: 'skip' });
  assert.equal(report.ok, false);
  assert.match(stepOf(report, 'reachable').detail ?? '', /could not be resolved/);
});

test('a refused connection is distinguished from a missing host', async () => {
  const report = await testRouter(makeRouter({ baseUrl: 'http://localhost:9' }), {
    apiKey: TEST_KEY,
    fetchImpl: failingFetch('ECONNREFUSED'),
  });
  assert.match(stepOf(report, 'reachable').detail ?? '', /nothing is listening/);
});

test('a timeout reports the budget it exceeded', async () => {
  const aborted = async (): Promise<Response> => {
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    throw error;
  };
  const report = await testRouter(makeRouter(), { apiKey: TEST_KEY, timeoutMs: 50, fetchImpl: aborted });
  assert.equal(stepOf(report, 'reachable').status, 'fail');
  assert.equal(stepOf(report, 'reachable').detail, 'No response within 50ms.');
});

test('an unusable URL is caught before any request is made', async () => {
  const transport = fakeFetch({ status: 200 });
  const report = await testRouter(makeRouter({ baseUrl: 'ftp://files.example' }), {
    apiKey: TEST_KEY,
    fetchImpl: transport.fetchImpl,
  });
  assert.deepEqual(statuses(report), { url: 'fail', reachable: 'skip', endpoint: 'skip', auth: 'skip' });
  assert.equal(transport.requests.length, 0, 'nothing may be sent to a URL we cannot parse');
  assert.equal(report.ok, false);
});

test('plain http to a remote host warns but still runs', async () => {
  const { report } = await probe(200, undefined, makeRouter({ baseUrl: 'http://api.remote.example' }));
  assert.equal(stepOf(report, 'url').status, 'warn');
  assert.match(stepOf(report, 'url').detail ?? '', /unencrypted/);
  assert.equal(report.ok, true);
});

test('the endpoint is configurable per router, per run, and globally', () => {
  const plain = makeRouter();
  assert.equal(endpointFor(plain), 'https://api.alpha.example/v1/messages', 'a sane default, not an assumption');
  assert.equal(endpointFor(plain, { defaultPath: '/health' }), 'https://api.alpha.example/health');
  const custom = makeRouter({ testPath: '/api/v1/chat' });
  assert.equal(endpointFor(custom, { defaultPath: '/health' }), 'https://api.alpha.example/api/v1/chat');
  assert.equal(endpointFor(custom, { path: '/ping' }), 'https://api.alpha.example/ping', 'an explicit --path wins');
});

test('a gateway that echoes the key back does not get it printed', async () => {
  const { report } = await probe(401, `{"error":"key ${TEST_KEY} is not valid"}`);
  assert.equal(JSON.stringify(report).includes(TEST_KEY), false, 'the report is safe to print and to log');
  assert.match(stepOf(report, 'auth').detail ?? '', /HTTP 401/);
});

test('every step is announced as it settles, in order', async () => {
  const seen: string[] = [];
  const transport = fakeFetch({ status: 200 });
  const report = await testRouter(makeRouter(), {
    apiKey: TEST_KEY,
    fetchImpl: transport.fetchImpl,
    onStep: (step) => seen.push(step.key),
  });
  assert.deepEqual(seen, ['url', 'reachable', 'endpoint', 'auth'], 'the live checklist gets each row once');
  assert.equal(seen.length, report.steps.length);
});
