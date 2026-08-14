/**
 * Command-line parsing (spec §25: "command parsing").
 *
 * The two behaviours worth guarding are the ones users notice: an unknown flag
 * must fail loudly with exit code 2 rather than being ignored, and everything
 * meant for Claude Code must survive untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, Flags } from '../src/args.ts';
import { RouterFlipError } from '../src/errors.ts';

test('parses a bare command with no arguments', () => {
  const parsed = parseArgs(['list']);
  assert.equal(parsed.command, 'list');
  assert.deepEqual(parsed.positionals, []);
  assert.deepEqual(parsed.rest, []);
});

test('no command at all leaves command undefined', () => {
  assert.equal(parseArgs([]).command, undefined);
});

test('positionals stay in order after the command', () => {
  const parsed = parseArgs(['edit', 'Alpha', 'extra']);
  assert.deepEqual(parsed.positionals, ['Alpha', 'extra']);
});

test('value flags accept both spaced and inline forms', () => {
  const spaced = new Flags(parseArgs(['add', '--name', 'Alpha']).flags);
  const inline = new Flags(parseArgs(['add', '--name=Alpha']).flags);
  assert.equal(spaced.str('name'), 'Alpha');
  assert.equal(inline.str('name'), 'Alpha');
});

test('a value flag with no value is a usage error', () => {
  assert.throws(
    () => parseArgs(['add', '--name']),
    (error: unknown) => error instanceof RouterFlipError && error.code === 'BAD_USAGE' && error.exitCode === 2,
  );
});

test('boolean flags and their short aliases set true', () => {
  const flags = new Flags(parseArgs(['use', 'Alpha', '-t', '--json']).flags);
  assert.equal(flags.bool('temporary'), true);
  assert.equal(flags.bool('json'), true);
  assert.equal(flags.bool('permanent'), false);
});

test('clustered short flags are expanded', () => {
  const flags = new Flags(parseArgs(['list', '-vj']).flags);
  assert.equal(flags.bool('verbose'), true);
  assert.equal(flags.bool('json'), true);
});

test('a short value alias takes the next token', () => {
  const flags = new Flags(parseArgs(['claude', '-r', 'Beta']).flags);
  assert.equal(flags.str('router'), 'Beta');
});

test('--no-color=false is honoured rather than blindly set', () => {
  const flags = new Flags(parseArgs(['list', '--no-color=false']).flags);
  assert.equal(flags.bool('no-color'), false);
});

test('an unknown flag is rejected with exit code 2', () => {
  assert.throws(
    () => parseArgs(['list', '--nope']),
    (error: unknown) => error instanceof RouterFlipError && error.code === 'BAD_USAGE' && error.exitCode === 2,
  );
});

test('an unknown short flag is rejected too', () => {
  assert.throws(() => parseArgs(['list', '-Z']), RouterFlipError);
});

test('everything after -- is forwarded verbatim', () => {
  const parsed = parseArgs(['use', 'Alpha', '--temporary', '--', '--resume', '-p', 'hello world']);
  assert.deepEqual(parsed.rest, ['--resume', '-p', 'hello world']);
  assert.deepEqual(parsed.positionals, ['Alpha']);
});

test('-- alone yields an empty passthrough, not a positional', () => {
  const parsed = parseArgs(['claude', '--']);
  assert.deepEqual(parsed.rest, []);
  assert.deepEqual(parsed.positionals, []);
});

test('passthrough commands forward unknown flags instead of failing', () => {
  const parsed = parseArgs(['claude', '--resume', '--verbose']);
  assert.equal(parsed.command, 'claude');
  // Parsing stops at the first foreign flag, so --verbose belongs to Claude Code.
  assert.deepEqual(parsed.rest, ['--resume', '--verbose']);
});

test('passthrough commands still read their own flags before the child args', () => {
  const parsed = parseArgs(['claude', '--router', 'Beta', '--dangerously-skip-permissions']);
  assert.equal(new Flags(parsed.flags).str('router'), 'Beta');
  assert.deepEqual(parsed.rest, ['--dangerously-skip-permissions']);
});

test('a bare positional after a passthrough command goes to the child', () => {
  const parsed = parseArgs(['run', 'explain this repo']);
  assert.deepEqual(parsed.rest, ['explain this repo']);
});

test('Flags.int parses numbers and rejects nonsense', () => {
  assert.equal(new Flags(parseArgs(['test', '--timeout', '2500']).flags).int('timeout'), 2500);
  assert.equal(new Flags({}).int('timeout'), undefined);
  assert.throws(() => new Flags({ timeout: 'soon' }).int('timeout'), RouterFlipError);
});

test('Flags.choice restricts values to the allowed set', () => {
  const allowed = ['env', 'helper'] as const;
  assert.equal(new Flags({ strategy: 'helper' }).choice('strategy', allowed), 'helper');
  assert.equal(new Flags({}).choice('strategy', allowed), undefined);
  assert.throws(() => new Flags({ strategy: 'magic' }).choice('strategy', allowed), RouterFlipError);
});
