/**
 * Provider registry.
 *
 * v1 ships Claude Code only (spec §28: the abstraction exists so Codex, Gemini
 * CLI and OpenCode can be added later — they are deliberately not implemented).
 * Everything else in the codebase goes through `providerFor()`, so adding one is
 * a matter of writing a `Provider` and listing it here.
 */
import { RouterFlipError } from '../errors.ts';
import { DEFAULT_PROVIDER, type ProviderId } from '../core/schema.ts';
import { claudeCode } from './claude-code.ts';
import type { Provider } from './types.ts';

const REGISTRY: Readonly<Record<ProviderId, Provider>> = {
  'claude-code': claudeCode,
};

export function providerFor(id: ProviderId = DEFAULT_PROVIDER): Provider {
  const provider = REGISTRY[id];
  if (!provider) {
    throw new RouterFlipError('PROVIDER_NOT_FOUND', `Unknown provider "${id}".`, {
      hint: `Supported providers: ${Object.keys(REGISTRY).join(', ')}.`,
    });
  }
  return provider;
}

export function allProviders(): readonly Provider[] {
  return Object.values(REGISTRY);
}

export { claudeCode };
export type { Provider } from './types.ts';
export type {
  ApplyOptions,
  ApplyResult,
  ClearResult,
  EnvDelta,
  PermanentStrategy,
  ProviderConfigSnapshot,
  ProviderDetection,
} from './types.ts';
export { activationFrom } from './claude-code.ts';
