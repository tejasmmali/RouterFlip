/**
 * Router ids and credential references.
 *
 * The id is a stable slug derived from the name at creation time. It is what
 * appears in config.json and in the credential store key, so renaming a router
 * never orphans its stored key.
 */

export function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'router';
}

/** Returns a slug not already present in `taken`, suffixing -2, -3, … */
export function uniqueId(name: string, taken: readonly string[]): string {
  const base = slugify(name);
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
