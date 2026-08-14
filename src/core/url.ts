/**
 * URL validation and normalization for router base URLs.
 *
 * Gateways are inconsistent about trailing slashes and some users paste a full
 * `/v1/messages` path. We normalize to an origin + optional base path with no
 * trailing slash, which is what `ANTHROPIC_BASE_URL` expects.
 */
import { RouterFlipError } from '../errors.ts';

export interface NormalizedUrl {
  readonly url: string;
  readonly origin: string;
  readonly host: string;
  readonly isLocal: boolean;
  readonly isInsecure: boolean;
}

/** Suffixes users commonly paste that belong to the API path, not the base URL. */
const KNOWN_API_SUFFIXES = ['/v1/messages', '/v1/complete', '/v1'];

export function normalizeUrl(raw: string): NormalizedUrl {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new RouterFlipError('INVALID_URL', 'Base URL is required.', {
      hint: 'Example: https://api.example-router.com',
    });
  }

  // Accept "example.com" by assuming https, which is what a user means.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new RouterFlipError('INVALID_URL', `"${trimmed}" is not a valid URL.`, {
      hint: 'Use a full URL such as https://api.example-router.com',
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RouterFlipError(
      'INVALID_URL',
      `Unsupported URL scheme "${parsed.protocol.replace(':', '')}".`,
      { hint: 'Base URLs must use http:// or https://' },
    );
  }

  if (parsed.hostname.length === 0) {
    throw new RouterFlipError('INVALID_URL', `"${trimmed}" is missing a hostname.`, {
      hint: 'Use a full URL such as https://api.example-router.com',
    });
  }

  if (parsed.username || parsed.password) {
    throw new RouterFlipError(
      'INVALID_URL',
      'Base URLs must not embed credentials (user:pass@host).',
      { hint: 'Remove the credentials from the URL and store the key separately.' },
    );
  }

  parsed.hash = '';
  parsed.search = '';

  let pathname = parsed.pathname.replace(/\/+$/, '');
  for (const suffix of KNOWN_API_SUFFIXES) {
    if (pathname.toLowerCase().endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length);
      break;
    }
  }
  parsed.pathname = pathname;

  const url = parsed.toString().replace(/\/+$/, '');
  const isLocal =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '0.0.0.0' ||
    parsed.hostname.endsWith('.localhost');

  return {
    url,
    origin: parsed.origin,
    host: parsed.host,
    isLocal,
    isInsecure: parsed.protocol === 'http:' && !isLocal,
  };
}

/** Non-throwing variant for validators and live form feedback. */
export function checkUrl(raw: string): { ok: true; value: NormalizedUrl } | { ok: false; error: string } {
  try {
    return { ok: true, value: normalizeUrl(raw) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid URL.' };
  }
}

/** Joins a base URL with a path without producing duplicate slashes. */
export function joinUrl(base: string, path: string): string {
  const left = base.replace(/\/+$/, '');
  const right = path.replace(/^\/+/, '');
  return right.length === 0 ? left : `${left}/${right}`;
}
