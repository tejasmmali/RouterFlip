/**
 * Debug logging (spec §21 "optional debug logging", §23 "never log a key").
 *
 * The log file is the one place a secret could be written to disk without anyone
 * looking at it, so the contract is pinned here: nothing on disk unless the user
 * asked for it, an explicit destination wins, `none` switches it off, and every
 * line — including one a caller passes carelessly — goes through the redactor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../src/logger.ts';
import { paths } from '../src/core/paths.ts';
import { ensureDir, existsSync } from '../src/core/fsx.ts';
import { withSandbox, TEST_KEY } from './helpers.ts';

/** Restores the process-wide logger, whatever the body does to it. */
async function withLogger(body: () => Promise<void> | void): Promise<void> {
  const saved = { level: logger.level, quiet: logger.quiet, env: process.env.ROUTERFLIP_LOG_FILE };
  try {
    await body();
  } finally {
    logger.setLevel(saved.level);
    logger.quiet = saved.quiet;
    if (saved.env === undefined) delete process.env.ROUTERFLIP_LOG_FILE;
    else process.env.ROUTERFLIP_LOG_FILE = saved.env;
  }
}

test('nothing is written to disk unless the user asks for verbosity', async () => {
  await withSandbox(async () => {
    await withLogger(() => {
      delete process.env.ROUTERFLIP_LOG_FILE;
      logger.setVerbose(false);

      assert.equal(logger.logFile, undefined, 'a quiet run has no log destination at all');
      logger.info('a routine line');
      logger.debug('a debug line');
      assert.equal(existsSync(paths().logFile), false, 'a normal run leaves no trace in the home directory');
    });
  });
});

test('--verbose logs to the home directory, and says where', async () => {
  await withSandbox(async () => {
    await withLogger(() => {
      delete process.env.ROUTERFLIP_LOG_FILE;
      logger.setVerbose(true);

      assert.equal(logger.logFile, paths().logFile);
      logger.debug('looked up the active router');
      const log = readFileSync(paths().logFile, 'utf8');

      assert.match(log, /looked up the active router/);
      assert.match(log, /log file: /, 'the first line names the file, so it can be found and pasted');
      assert.match(log, /DEBUG/, 'the level is on every line');
      assert.match(log, /^\d{4}-\d{2}-\d{2}T/, 'so is a timestamp');
    });
  });
});

test('a secret is redacted on its way into the log', async () => {
  await withSandbox(async () => {
    await withLogger(() => {
      delete process.env.ROUTERFLIP_LOG_FILE;
      logger.setVerbose(true);
      logger.protect(TEST_KEY);

      // Exactly the careless call the redactor exists to survive.
      logger.debug(`resolved credential ${TEST_KEY} for alpha-1`);
      logger.info('gateway said: {"error":"invalid key sk-live-9876543210abcdef"}');
      const log = readFileSync(paths().logFile, 'utf8');

      assert.equal(log.includes(TEST_KEY), false, 'the registered secret never reaches the file');
      assert.equal(log.includes('sk-live-9876543210abcdef'), false, 'nor does a key-shaped string it was never told about');
      assert.match(log, /resolved credential .*cdef for alpha-1/, 'the line is still useful after masking');
    });
  });
});

test('an explicit destination wins over the default', async () => {
  await withSandbox((sandbox) => {
    return withLogger(() => {
      const elsewhere = join(sandbox.home, 'nested', 'debug.log');
      process.env.ROUTERFLIP_LOG_FILE = elsewhere;
      logger.setVerbose(true);

      assert.equal(logger.logFile, elsewhere);
      logger.debug('into the chosen file');
      assert.match(readFileSync(elsewhere, 'utf8'), /into the chosen file/, 'a missing parent directory is created');
      assert.equal(existsSync(paths().logFile), false, 'and the default is left alone');
    });
  });
});

test('an explicit destination also applies without --verbose', async () => {
  await withSandbox((sandbox) => {
    return withLogger(() => {
      const chosen = join(sandbox.home, 'always.log');
      process.env.ROUTERFLIP_LOG_FILE = chosen;
      logger.setVerbose(false);

      logger.warn('something worth keeping');
      logger.debug('below the level, so not recorded');
      const log = readFileSync(chosen, 'utf8');

      assert.match(log, /something worth keeping/);
      assert.equal(log.includes('below the level'), false, 'the level still filters what is recorded');
    });
  });
});

test('ROUTERFLIP_LOG_FILE=none opts out of disk logging entirely', async () => {
  await withSandbox(async () => {
    await withLogger(() => {
      for (const value of ['none', 'off', '0', 'FALSE']) {
        process.env.ROUTERFLIP_LOG_FILE = value;
        logger.setVerbose(true);
        assert.equal(logger.logFile, undefined, `${value} should disable the log file`);
      }
      logger.debug('stderr only');
      assert.equal(existsSync(paths().logFile), false);
    });
  });
});

test('an unwritable destination is ignored rather than failing the command', async () => {
  await withSandbox((sandbox) => {
    return withLogger(() => {
      // Put a real *file* where the log's parent directory would have to be, so
      // the directory cannot be created and the append cannot succeed.
      ensureDir(sandbox.home);
      const blocker = join(sandbox.home, 'blocker');
      writeFileSync(blocker, 'not a directory', 'utf8');
      process.env.ROUTERFLIP_LOG_FILE = join(blocker, 'impossible.log');
      logger.setVerbose(true);

      assert.doesNotThrow(() => logger.debug('this line has nowhere to go'));
      assert.equal(readFileSync(blocker, 'utf8'), 'not a directory', 'and nothing else was damaged trying');
    });
  });
});
