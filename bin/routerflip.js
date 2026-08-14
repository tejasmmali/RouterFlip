#!/usr/bin/env node
// RouterFlip launcher.
//
// Kept deliberately tiny: it resolves the compiled entry point next to this
// file so that `npm i -g routerflip` works without a shebang-rewrite step,
// and reports a friendly message if the package was installed without a build.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, '..', 'dist', 'cli.js');

if (!existsSync(compiled)) {
  process.stderr.write(
    '\nRouterFlip is not built.\n\n' +
      'If you are running from a git checkout, run:\n' +
      '  npm install && npm run build\n\n',
  );
  process.exit(1);
}

const { main } = await import(compiled);
await main(process.argv.slice(2));
