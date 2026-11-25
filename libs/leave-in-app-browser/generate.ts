/**
 * Writes MiConnect's gate from the one definition: `nginx.conf` (`nginx.ts`) and a copy of
 * `interstitial.html`, into `infrastructure/authentik/leave-in-app-browser/`.
 *
 *   bun libs/leave-in-app-browser/generate.ts          # write
 *   bun libs/leave-in-app-browser/generate.ts --check  # exit 1 naming each file that differs
 *
 * `--check` runs in `make test-ci-scripts`, so an edit to the tokens, the exemptions or the page
 * that is not regenerated fails CI instead of leaving MiConnect on the old definition.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderGateConf } from './nginx';

const here = import.meta.dir;
const target = join(here, '..', '..', 'infrastructure', 'authentik', 'leave-in-app-browser');
const html = readFileSync(join(here, 'interstitial.html'), 'utf8');
const files: Record<string, string> = {
  'nginx.conf': renderGateConf(html),
  'interstitial.html': html,
};

const check = process.argv.includes('--check');
let stale = 0;
for (const [name, content] of Object.entries(files)) {
  const path = join(target, name);
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      console.error(
        `[leave-iab] ${path} differs from its source - run: bun libs/leave-in-app-browser/generate.ts`
      );
      stale++;
    }
  } else {
    writeFileSync(path, content);
    console.log(`[leave-iab] wrote ${path}`);
  }
}
if (stale) process.exit(1);
if (check) console.log('[leave-iab] MiConnect gate matches libs/leave-in-app-browser');
