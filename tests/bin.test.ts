/**
 * The published launcher shim.
 *
 * `bin/routerflip.js` is the only file an `npm i -g routerflip` user actually
 * executes, and it is not covered by anything that imports from `src/`: it loads
 * `dist/` by path. That made it possible to ship a shim that threw on Windows
 * (`import('C:\\…')` is parsed as the protocol `c:`) while every other test
 * passed. This runs the real file, the way npm does, against the real build.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/routerflip.js', import.meta.url));
const DIST = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('the launcher shim runs the compiled CLI', { skip: existsSync(DIST) ? false : 'run `npm run build` first' }, () => {
  const result = spawnSync(process.execPath, [BIN, 'version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `exit ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /routerflip/i);
});
