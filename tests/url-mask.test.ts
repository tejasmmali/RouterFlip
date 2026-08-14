/**
 * URL handling and secret masking (spec §25: "invalid URLs", "masking API keys").
 *
 * The masking assertions are deliberately strict about *width*: a mask that grew
 * with the secret would leak its length, so the fixed-width guarantee is tested
 * rather than just "does not contain the key".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, joinUrl, normalizeUrl } from '../src/core/url.ts';
import { maskSecret, maskSecretAscii, redact, redactObject, secretFingerprint } from '../src/core/mask.ts';
import { RouterFlipError } from '../src/errors.ts';

const BULLET = String.fromCharCode(0x2022);

test('a bare hostname is assumed to be https', () => {
  assert.equal(normalizeUrl('api.example.com').url, 'https://api.example.com');
});

test('trailing slashes, query strings and fragments are dropped', () => {
  assert.equal(normalizeUrl('https://api.example.com///').url, 'https://api.example.com');
  assert.equal(normalizeUrl('https://api.example.com/?a=1#frag').url, 'https://api.example.com');
});

test('a pasted API path is stripped back to the base URL', () => {
  // Claude Code appends /v1/messages itself; leaving it on would double the path.
  assert.equal(normalizeUrl('https://api.example.com/v1/messages').url, 'https://api.example.com');
  assert.equal(normalizeUrl('https://api.example.com/v1').url, 'https://api.example.com');
  assert.equal(normalizeUrl('https://gate.example.com/proxy/v1').url, 'https://gate.example.com/proxy');
});

test('a non-API path is preserved', () => {
  assert.equal(normalizeUrl('https://gate.example.com/anthropic').url, 'https://gate.example.com/anthropic');
});

test('ports and paths survive normalization', () => {
  const normalized = normalizeUrl('http://localhost:8787/relay/');
  assert.equal(normalized.url, 'http://localhost:8787/relay');
  assert.equal(normalized.isLocal, true);
  // Plain http to localhost is not flagged: nothing leaves the machine.
  assert.equal(normalized.isInsecure, false);
});

test('plain http to a remote host is flagged as insecure', () => {
  assert.equal(normalizeUrl('http://api.example.com').isInsecure, true);
});

test('an empty URL is rejected', () => {
  assert.throws(() => normalizeUrl('   '), (error: unknown) => error instanceof RouterFlipError && error.code === 'INVALID_URL');
});

test('unsupported schemes are rejected', () => {
  assert.throws(() => normalizeUrl('ftp://files.example.com'), RouterFlipError);
  assert.throws(() => normalizeUrl('file:///etc/passwd'), RouterFlipError);
});

test('a URL with embedded credentials is rejected', () => {
  assert.throws(
    () => normalizeUrl('https://user:secret@api.example.com'),
    (error: unknown) => error instanceof RouterFlipError && /must not embed credentials/.test(error.message),
  );
});

test('checkUrl reports problems instead of throwing', () => {
  const bad = checkUrl('not a url at all');
  assert.equal(bad.ok, false);
  const good = checkUrl('api.example.com');
  assert.equal(good.ok, true);
});

test('joinUrl never doubles or drops a slash', () => {
  assert.equal(joinUrl('https://a.example', '/v1/messages'), 'https://a.example/v1/messages');
  assert.equal(joinUrl('https://a.example/', 'v1/messages'), 'https://a.example/v1/messages');
  assert.equal(joinUrl('https://a.example', ''), 'https://a.example');
});

test('a masked key never contains the secret and has a fixed width', () => {
  const short = maskSecret('sk-ant-1234567890abcdef');
  const long = maskSecret(`sk-ant-${'x'.repeat(200)}wxyz`);
  assert.equal(short.includes('1234567890'), false);
  assert.equal(short, `${BULLET.repeat(12)}cdef`);
  assert.equal(long, `${BULLET.repeat(12)}wxyz`);
  assert.equal(short.length, long.length, 'mask width must not reveal the key length');
});

test('a short secret reveals nothing at all', () => {
  assert.equal(maskSecret('short'), BULLET.repeat(12));
  assert.equal(maskSecret(''), BULLET.repeat(12));
  assert.equal(maskSecret(undefined), BULLET.repeat(12));
  assert.equal(maskSecretAscii('short'), '*'.repeat(12));
});

test('redact replaces known secrets anywhere in a string', () => {
  const key = 'sk-ant-api03-abcdefghijklmnop';
  const text = `POST failed with ${key} in the header`;
  const clean = redact(text, [key]);
  assert.equal(clean.includes(key), false);
  assert.equal(clean.includes(BULLET), true);
});

test('redact catches key-shaped strings it was never told about', () => {
  const clean = redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz');
  assert.equal(clean.includes('abcdefghijklmnopqrstuvwxyz'), false);
});

test('redactObject masks values under sensitive key names', () => {
  const masked = redactObject({
    baseUrl: 'https://api.example.com',
    ANTHROPIC_API_KEY: 'sk-ant-0123456789abcdef',
    nested: { authorization: 'Bearer 0123456789abcdef' },
  }) as Record<string, unknown>;
  assert.equal(masked.baseUrl, 'https://api.example.com');
  assert.equal(String(masked.ANTHROPIC_API_KEY).includes('0123456789'), false);
  assert.equal(JSON.stringify(masked).includes('0123456789abcdef'), false);
});

test('fingerprints differ per key and reveal nothing', () => {
  const a = secretFingerprint('sk-ant-aaaaaaaaaaaa');
  const b = secretFingerprint('sk-ant-bbbbbbbbbbbb');
  assert.notEqual(a, b);
  assert.equal(a.length, 4);
  assert.equal(secretFingerprint('sk-ant-aaaaaaaaaaaa'), a, 'must be stable');
});
