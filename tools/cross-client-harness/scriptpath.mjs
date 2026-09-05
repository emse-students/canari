/**
 * WHERE ONE OF THIS RIG'S SCRIPTS ACTUALLY LIVES, resolved once instead of guessed four times.
 *
 * ## The bug this exists to end
 *
 * The runners used to sit at the harness root. They moved into `archive/`, and every place that
 * spawns one by BARE NAME with `cwd` set to its own directory broke - silently, because the child
 * fails with `Module not found` and the parent was not reading its exit code. It has now been found
 * four separate times:
 *
 * 1. `type.mjs`'s teardown spawned `pin.mjs` from `archive/`, so TYPE-3 re-entered no PIN, recorded
 *    `unlocked: false`, returned PASS anyway, and left W1 locked - which made TYPE-1, 4 and 5 error
 *    on a sidebar that was not there.
 * 2. `rows.mjs` joined a runner's bare name onto the harness root and reported `its runner no longer
 *    exists` for EVERY archived row - a warning that fires on every row, which hides the one case it
 *    was written for.
 * 3. `ready-repair.mjs` spawned `pin.mjs` with `cwd` = `archive/` AND `stdio: 'ignore'`, so the
 *    preflight's own repair did nothing at all, four times per device, and then declared the client
 *    NOT FIT TO MEASURE. Measured 2026-09-04 on W1, W2 and A1.
 * 4. `healrevoke.mjs` spawns `login.mjs`, `pin.mjs` and `purge-devices.mjs` the same way.
 *
 * Each was fixed where it was found, which is how a defect gets found a fourth time. The name is a
 * FACT about the tree, and it belongs in one place.
 *
 * ## Why a search and not a constant
 *
 * Scripts live at the root or under `archive/`, and which one a given name is in has changed twice.
 * A name is unique across both - two scripts sharing one would be a fault of its own, and
 * `inventory.mjs` is what catches it - so the first hit wins and the order is stable.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The harness root, whatever directory the caller happens to sit in. */
export const HARNESS_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** The directories a script may live in, searched in this order. */
export const SCRIPT_DIRS = [HARNESS_ROOT, join(HARNESS_ROOT, 'archive')];

/**
 * The absolute path of `name`, or `null` when no directory has it.
 *
 * `null` for a reader that must survive the absence - `rows.mjs` treats a missing runner as a fact
 * about the ledger ("this verdict was taken by a script that no longer exists") rather than as an
 * error of its own.
 */
export function findScript(name) {
  return SCRIPT_DIRS.map((d) => join(d, name)).find((f) => existsSync(f)) ?? null;
}

/**
 * The absolute path of `name`, or a throw naming every directory searched.
 *
 * FOR ANYTHING THAT SPAWNS. A spawn given a name it cannot resolve does not fail loudly on its own:
 * the child exits non-zero with a message the parent usually discards, and the caller sees a
 * gesture that "ran" and changed nothing. Refusing here turns that into one sentence that names the
 * script and where it was not.
 */
export function requireScript(name) {
  const found = findScript(name);
  if (!found) {
    throw new Error(`no script named ${name} in ${SCRIPT_DIRS.join(' or ')}`);
  }
  return found;
}
