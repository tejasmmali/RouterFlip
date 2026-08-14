/**
 * Version reporting.
 *
 * Read from package.json at runtime rather than baked into a constant, so the
 * published binary can never disagree with the package it shipped in.
 */
import { readFileSync } from 'node:fs';

export interface VersionInfo {
  readonly name: string;
  readonly version: string;
  readonly node: string;
  readonly platform: string;
}

let cached: VersionInfo | undefined;

export function versionInfo(): VersionInfo {
  if (cached) return cached;
  let name = 'routerflip';
  let version = '0.0.0';
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
    if (typeof parsed.name === 'string') name = parsed.name;
    if (typeof parsed.version === 'string') version = parsed.version;
  } catch {
    // A missing package.json means someone is running from an odd layout; the
    // fallback keeps `--version` working rather than crashing over metadata.
  }
  cached = { name, version, node: process.version, platform: `${process.platform}-${process.arch}` };
  return cached;
}
