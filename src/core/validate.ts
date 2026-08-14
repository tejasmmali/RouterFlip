/**
 * A tiny schema validator.
 *
 * This is the "Zod or equivalent" piece. It is hand-rolled for one reason:
 * RouterFlip ships with zero runtime dependencies so that `npm i -g routerflip`
 * is a single small download and startup stays in the low tens of milliseconds.
 * The surface below is deliberately Zod-shaped so it would be a mechanical swap
 * if the project ever wants the real thing.
 */

export interface Issue {
  readonly path: string;
  readonly message: string;
}

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly Issue[] };

export interface Schema<T> {
  readonly safeParse: (input: unknown, path?: string) => ParseResult<T>;
  readonly optional: () => Schema<T | undefined>;
  readonly withDefault: (fallback: T | (() => T)) => Schema<T>;
}

export type Infer<S> = S extends { readonly safeParse: (input: unknown, path?: string) => ParseResult<infer T> } ? T : never;

/**
 * Structural view of a schema, used for generic constraints.
 *
 * `Schema<T>` is invariant in `T` (because `withDefault` accepts a `T`), so a
 * `Record<string, Schema<unknown>>` constraint would reject every concrete
 * schema. Constraining on the read-only shape sidesteps that without `any`
 * leaking into the inferred output types.
 */
export interface ReadableSchema<T> {
  readonly safeParse: (input: unknown, path?: string) => ParseResult<T>;
}
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type AnySchema = ReadableSchema<any>;

/** Collapses an intersection into a single object type for readable errors. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

type UndefinedKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T];

/**
 * Marks properties that may be `undefined` as genuinely optional.
 *
 * `object()` omits keys whose parse produced `undefined`, so `{ a: 1 }` is a
 * valid parse of a shape with an optional `b`. Without this, every construction
 * site would have to write `b: undefined` explicitly.
 */
export type Optionalize<T> = Simplify<
  { [K in Exclude<keyof T, UndefinedKeys<T>>]: T[K] } & { [K in UndefinedKeys<T>]?: T[K] }
>;

function issue(path: string, message: string): ParseResult<never> {
  return { ok: false, issues: [{ path, message }] };
}

function make<T>(run: (input: unknown, path: string) => ParseResult<T>): Schema<T> {
  const schema: Schema<T> = {
    safeParse: (input, path = '') => run(input, path),
    optional: () =>
      make<T | undefined>((input, path) => (input === undefined ? { ok: true, value: undefined } : run(input, path))),
    withDefault: (fallback) =>
      make<T>((input, path) => {
        if (input === undefined) {
          const value = typeof fallback === 'function' ? (fallback as () => T)() : fallback;
          return { ok: true, value };
        }
        return run(input, path);
      }),
  };
  return schema;
}

export interface StringOptions {
  readonly min?: number;
  readonly max?: number;
  readonly trim?: boolean;
  readonly pattern?: RegExp;
  readonly patternMessage?: string;
  readonly label?: string;
  /** Extra rule. Returns an error message, or undefined when the value is fine. */
  readonly check?: (value: string) => string | undefined;
}

export function string(options: StringOptions = {}): Schema<string> {
  const { min = 0, max = Number.MAX_SAFE_INTEGER, trim = true, pattern, patternMessage, label, check } = options;
  return make<string>((input, path) => {
    if (typeof input !== 'string') return issue(path, `${label ?? (path || 'value')} must be a string.`);
    const value = trim ? input.trim() : input;
    if (value.length < min) {
      return issue(path, min === 1 ? `${label ?? (path || 'value')} is required.` : `${label ?? (path || 'value')} must be at least ${min} characters.`);
    }
    if (value.length > max) return issue(path, `${label ?? (path || 'value')} must be at most ${max} characters.`);
    if (pattern && !pattern.test(value)) {
      return issue(path, patternMessage ?? `${label ?? (path || 'value')} has an invalid format.`);
    }
    const problem = check?.(value);
    if (problem !== undefined) return issue(path, problem);
    return { ok: true, value };
  });
}

export function boolean(): Schema<boolean> {
  return make<boolean>((input, path) =>
    typeof input === 'boolean' ? { ok: true, value: input } : issue(path, `${path || 'value'} must be true or false.`),
  );
}

export function integer(options: { min?: number; max?: number } = {}): Schema<number> {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
  return make<number>((input, path) => {
    if (typeof input !== 'number' || !Number.isFinite(input) || !Number.isInteger(input)) {
      return issue(path, `${path || 'value'} must be a whole number.`);
    }
    if (input < min || input > max) return issue(path, `${path || 'value'} must be between ${min} and ${max}.`);
    return { ok: true, value: input };
  });
}

export function literalUnion<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return make<T[number]>((input, path) =>
    typeof input === 'string' && (values as readonly string[]).includes(input)
      ? { ok: true, value: input as T[number] }
      : issue(path, `${path || 'value'} must be one of: ${values.join(', ')}.`),
  );
}

export function array<T>(item: Schema<T>): Schema<T[]> {
  return make<T[]>((input, path) => {
    if (!Array.isArray(input)) return issue(path, `${path || 'value'} must be a list.`);
    const out: T[] = [];
    const issues: Issue[] = [];
    input.forEach((element, index) => {
      const result = item.safeParse(element, `${path}[${index}]`);
      if (result.ok) out.push(result.value);
      else issues.push(...result.issues);
    });
    return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
  });
}

export function record(value: Schema<string>): Schema<Record<string, string>> {
  return make<Record<string, string>>((input, path) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return issue(path, `${path || 'value'} must be an object.`);
    }
    const out: Record<string, string> = {};
    const issues: Issue[] = [];
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      const result = value.safeParse(item, path ? `${path}.${key}` : key);
      if (result.ok) out[key] = result.value;
      else issues.push(...result.issues);
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
  });
}

/** Object schema. Unknown keys are dropped (forward/backward compatible reads). */
export function object<S extends Record<string, AnySchema>>(
  shape: S,
): Schema<Optionalize<{ [K in keyof S]: Infer<S[K]> }>> {
  type Out = Optionalize<{ [K in keyof S]: Infer<S[K]> }>;
  return make<Out>((input, path) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return issue(path, `${path || 'value'} must be an object.`);
    }
    const source = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const issues: Issue[] = [];
    for (const [key, schema] of Object.entries(shape)) {
      const result = schema.safeParse(source[key], path ? `${path}.${key}` : key);
      if (result.ok) {
        if (result.value !== undefined) out[key] = result.value;
      } else {
        issues.push(...result.issues);
      }
    }
    return issues.length > 0
      ? { ok: false, issues }
      : { ok: true, value: out as Out };
  });
}

export function formatIssues(issues: readonly Issue[]): string {
  return issues.map((item) => (item.path ? `  • ${item.path}: ${item.message}` : `  • ${item.message}`)).join('\n');
}
