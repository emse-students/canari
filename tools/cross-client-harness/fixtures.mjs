/**
 * WHERE A STAGED INPUT FILE LIVES - resolved from the HARNESS ROOT, never from the caller.
 *
 * WHY IT EXISTS: A MOVE BROKE A RELATIVE PATH AND NOTHING SAID SO. `msg4.mjs` and `mut.mjs` both
 * spelt `abs('./fixtures/msg4-image.png')` against their own `import.meta.url`, which was correct
 * while they sat at the harness root and became `archive/fixtures/...` the day the runners moved
 * into `archive/`. The directory they now named has never existed.
 *
 * IT FAILED SILENTLY BECAUSE CDP ACCEPTS A PATH THAT DOES NOT EXIST. `DOM.setFileInputFiles` takes
 * the string without complaint, the input ends up holding a `File` whose bytes cannot be read, and
 * the failure surfaces minutes later and elsewhere: MSG-4 hung 30 s on a staging tray that never
 * cleared and died in `until() timed out ... indexOf('EN ATTENTE') === -1` with no verdict recorded,
 * while MSG-6 met the same fixture and recorded PASS-DIRTY on `Erreur envoi media: A requested file
 * or directory could not be found` - blaming the product for a file the harness never handed it.
 * Measured 2026-09-04.
 *
 * SO THE DEPTH IS NOT THE CALLER'S PROBLEM. This module sits at the harness root, so its own
 * `import.meta.url` is the anchor and a runner may live anywhere - `archive/`, the root, a
 * subdirectory written next year - without its fixtures moving with it.
 *
 * AND A MISSING ONE IS NAMED AT RESOLUTION, with the list of what IS there: a typo and a genuinely
 * absent file are different findings, and the caller cannot tell them apart from a bare path.
 */
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = new URL('./fixtures/', import.meta.url);

/**
 * The absolute path of a staged input file, asserted to exist.
 *
 * @param {string} name the file's name inside `fixtures/`, e.g. `msg4-image.png`
 * @returns {string} an absolute path, safe to hand to `attachFiles`
 */
export function fixture(name) {
  const path = fileURLToPath(new URL(name, DIR));
  if (!existsSync(path)) {
    // `readdirSync` on a directory that is itself missing would throw over the top of the message
    // that explains the problem, which is how one fault becomes a stack trace about another.
    const have = existsSync(fileURLToPath(DIR)) ? readdirSync(fileURLToPath(DIR)) : ['(no fixtures/ directory at all)'];
    throw new Error(
      `fixture(${JSON.stringify(name)}) does not exist at ${path}. Available: ${have.join(', ')}. ` +
        `Fixtures are INPUT and are committed; if one is absent, check that no ignore rule swallows ` +
        `it - "*.png" did exactly that until 2026-09-04.`
    );
  }
  return path;
}
