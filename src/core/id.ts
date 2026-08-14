/**
 * Router ids and credential references.
 *
 * The id is a stable slug derived from the name at creation time. It is what
 * appears in config.json and in the credential store key, so renaming a router
 * never orphans its stored key.
 */

export function slugify(input: string, fallback = 'router'): string {
  const base = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : fallback;
}

/** Returns a slug not already present in `taken`, suffixing -2, -3, … */
export function uniqueId(name: string, taken: readonly string[], fallback = 'router'): string {
  const base = slugify(name, fallback);
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** The account name used inside the OS credential store. */
export function credentialRefFor(id: string): string {
  return `routerflip-${id}`;
}

/**
 * The credential-store key for one account of a router.
 *
 * The separator is a dot on purpose. Ids are slugs, so they contain only
 * `[a-z0-9-]`; a `-` here would make router `alpha` + account `main`
 * indistinguishable from a router whose id is `alpha-main`, and two routers would
 * then read and delete each other's keys. A dot cannot occur in a slug and is
 * allowed by the credential backends' `assertValidRef`.
 *
 * The *first* account of a router deliberately does not use this: it keeps the
 * router's own `credentialRefFor(routerId)`, which is what makes the migration
 * from one-key-per-router a pure config rewrite with no key ever moved.
 */
export function accountCredentialRefFor(routerId: string, accountId: string): string {
  return `${credentialRefFor(routerId)}.${accountId}`;
}

/** Names are compared case-insensitively and whitespace-insensitively. */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function sameName(a: string, b: string): boolean {
  return normalizeName(a).toLowerCase() === normalizeName(b).toLowerCase();
}

export function nowIso(): string {
  return new Date().toISOString();
}
