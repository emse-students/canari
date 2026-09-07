#!/usr/bin/env node
/**
 * THE GATE THAT WOULD HAVE SAVED GRP-3 AND GRP-8, pinned on both sides.
 *
 * On 2026-09-07 a `vite build` running in the background overlapped a `git switch`. The artefact it
 * produced was internally consistent, the deploy succeeded, both browsers reloaded onto it and
 * reported themselves current - and it did not contain `data-remove-member`, the attribute those two
 * rows address a member through. Both came back `FAIL`, accusing the product of the rig's mistake.
 * `bundle.mjs` compared the client to the DEPLOYMENT; nothing compared the deployment to the SOURCE.
 *
 * `staleReason` is the missing comparison, and it takes plain objects on purpose: this file runs in
 * CI on a fresh checkout, where there is no build directory, no estate and no out-of-tree
 * `names.mjs`. Only the hash itself needs the tree, and what is asserted about it is the property the
 * gate rests on - the same bytes give the same answer, and one more file gives a different one.
 *
 *   bun archive/sourcestamp-selftest.mjs
 */
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sourceStamp, staleReason } from '../../../frontend/scripts/source-stamp.mjs';

let failed = 0;

/** @param {string} what @param {boolean} held */
function check(what, held) {
  console.log(`  ${held ? 'ok  ' : 'FAIL'}   ${what}`);
  if (!held) failed++;
}

const STAMP = { id: '__sveltekit_abc123', sha: 'deadbeefdeadbeef', files: 800 };
const SAME = { sha: 'deadbeefdeadbeef', files: 800 };

check(
  'the estate serving the last build, made from this source, is the only silent case',
  staleReason('__sveltekit_abc123', STAMP, SAME) === null
);

check(
  'no stamp at all is a refusal, not a pass - an unknown provenance is not a good one',
  /does not exist/.test(String(staleReason('__sveltekit_abc123', null, SAME)))
);

check(
  'a deployment older than the build directory is named as such',
  /the last build here produced __sveltekit_abc123/.test(
    String(staleReason('__sveltekit_older1', STAMP, SAME))
  )
);

check(
  'THE ONE THAT COST TWO ROWS: the right build id, the wrong source',
  /does not contain the change under test/.test(
    String(staleReason('__sveltekit_abc123', STAMP, { sha: '0000111122223333', files: 801 }))
  )
);

check(
  'and it prints BOTH hashes, so a reader can tell which half moved',
  /deadbeefdeadbeef/.test(String(staleReason('__sveltekit_abc123', STAMP, { sha: '0000111122223333', files: 801 }))) &&
    /0000111122223333/.test(String(staleReason('__sveltekit_abc123', STAMP, { sha: '0000111122223333', files: 801 })))
);

// A DIFFERENCE IN FILE COUNT ALONE IS NOT THE SIGNAL. The hash is, and the count is there for the
// reader - so a stamp whose count drifted while the hash held must stay silent, or the gate would
// refuse over its own diagnostics.
check(
  'the hash decides, not the count beside it',
  staleReason('__sveltekit_abc123', STAMP, { sha: 'deadbeefdeadbeef', files: 12 }) === null
);

// THE HASH ITSELF, over the real tree - the only part that touches the disk.
const first = sourceStamp();
const second = sourceStamp();
check('the same tree hashes the same twice - a gate that drifts on its own is noise', first.sha === second.sha);
check('and it counted the files it hashed', first.files > 100 && first.files === second.files);

// One more file under `src`, and the answer must move. Written into the REAL tree because that is
// the only thing `sourceStamp` reads, and removed in a `finally` so a failure here cannot leave a
// stray module behind for the next build to compile.
const probe = fileURLToPath(new URL('../../../frontend/src/lib/__sourcestamp-selftest.ts', import.meta.url));
try {
  writeFileSync(probe, '// written by sourcestamp-selftest.mjs, removed in the same run\n');
  const withProbe = sourceStamp();
  check('one added file changes the hash', withProbe.sha !== first.sha);
  check('and the count says how many it saw', withProbe.files === first.files + 1);
} finally {
  rmSync(probe, { force: true });
}

check('and removing it restores the original answer', sourceStamp().sha === first.sha);

console.log(
  failed === 0
    ? '[sourcestamp] clean - a build that is not this source is refused, and an unchanged tree is not'
    : `[sourcestamp] ${failed} assertion(s) failed`
);
process.exit(failed === 0 ? 0 : 1);
