/**
 * Deletes the communities a CRASHED check left on production.
 *
 *   node cleanup.mjs [--dry]
 *
 * WHY THIS EXISTS AT ALL, given every runner deletes its own venue. Because a runner that dies
 * mid-way does not: COMM-6 threw on a bad query on 2026-08-20 and left `C6 COMM6-mt1gh7hx4it`
 * behind, with its distribution group and its member. One is harmless; a phase of twenty-five rows
 * re-run through a week of fixes is not, and the campaign's first requirement is a venue whose
 * contents are all accounted for.
 *
 * **AN ALLOWLIST, NEVER A DENYLIST**, and here the NAME is the allowlist. Every venue a check builds
 * is named `C<n> COMM<n>-<mark>`, where the mark is minted by `results.mjs` and cannot collide with
 * anything a person would type. Nothing else is eligible - not the shared `Campagne de test`, not
 * MiTV, not a community whose name merely looks like a test. A destructive control that decides what
 * to spare has already got it backwards.
 *
 * **DELETED THROUGH THE PRODUCT, NEVER THROUGH THE DATABASE.** Deleting the rows would leave the
 * community's Graine distribution group alive on the key service, named by nothing - the exact
 * leftover `deleteCommunity` was written to avoid, and one nobody could ever find again. So this
 * drives the same confirmation dialog a person does, name typed and all, and it is therefore also a
 * standing check that that path still works.
 *
 * It reads the list from the DATABASE rather than from the sidebar: a community W1 has left, or one
 * whose sidebar entry never loaded, is exactly the debris worth finding, and the screen would not
 * show it. What the screen then refuses is reported per community rather than thrown - a sweep that
 * stops on the first stubborn one is a sweep nobody runs twice.
 */
import { client } from './chat.mjs';
import { deleteCommunity, enterCommunities, openCommunity } from './comm.mjs';
import { psql } from './ssh.mjs';
import { PORTS } from './names.mjs';

/**
 * AN ALLOWLIST, and it is only as good as its enumeration. COMM-12 builds TWO venues per run and
 * names the arm in between - "C12 shared COMM12-<mark>" - which the single shape did not match, so
 * every run of it left a community behind that no sweep would ever take. Found 2026-08-20 with four
 * of seven communities matching and a fifth sitting there in plain sight. Widen this by ENUMERATING
 * what the runners mint, never by relaxing it: the price of a loose pattern here is a real
 * community, typed name and all, and there is no undo.
 */
const DEBRIS = /^C\d+( [a-z]+)? COMM\d+-[0-9a-z]+$/;

const dry = process.argv.includes('--dry');

const named = psql(`SELECT id, name FROM channel_workspaces ORDER BY "createdAt"`)
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const at = line.indexOf('|');
    return { id: line.slice(0, at), name: line.slice(at + 1) };
  });

const debris = named.filter((w) => DEBRIS.test(w.name));

console.log(`[cleanup] ${named.length} communities on production, ${debris.length} match a check's venue`);
for (const w of debris) console.log(`  ${w.id.slice(0, 8)}  ${w.name}`);

// WHAT IT DID NOT MATCH IS THE HALF WORTH READING, and it used to print nothing at all. An
// allowlist is only as good as its enumeration, so its failure mode is a venue sitting in plain
// sight while the sweep reports success - "0 match a check's venue" reads as "the estate is clean"
// and means "I recognised nothing". It has happened twice: COMM-12's second venue on 2026-08-20,
// and a scratch probe on 2026-08-21 that minted `C22 PROBE-<mark>` outside the shape. Naming the
// rest costs one line and makes the next escape visible on the run that causes it. These are REAL
// communities, so they are listed and never touched.
const strangers = named.filter((w) => !DEBRIS.test(w.name));
if (strangers.length > 0) {
  console.log(`[cleanup] ${strangers.length} NOT matched - left alone, check none of these is debris:`);
  for (const w of strangers) console.log(`  ${w.id.slice(0, 8)}  ${w.name}`);
}

if (debris.length === 0) {
  console.log('[cleanup] nothing to sweep');
  process.exit(0);
}
if (dry) {
  console.log('[cleanup] --dry: nothing deleted');
  process.exit(0);
}

const w1 = await client(PORTS.W1);
const failed = [];

for (const w of debris) {
  try {
    await enterCommunities(w1);
    await openCommunity(w1, w.name);
    await deleteCommunity(w1, w.name);
    console.log(`[cleanup] deleted ${w.name}`);
  } catch (e) {
    failed.push(`${w.name}: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`[cleanup] COULD NOT delete ${w.name} - ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Re-read rather than trust the gestures: the dialog reports success from the screen, and what the
// campaign needs is the table saying they are gone.
const left = psql(`SELECT name FROM channel_workspaces`)
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => DEBRIS.test(l));

console.log(`[cleanup] ${debris.length - left.length}/${debris.length} swept, ${left.length} left`);
for (const name of left) console.log(`  still there: ${name}`);
for (const f of failed) console.log(`  failure: ${f}`);

w1.close();
process.exit(left.length === 0 ? 0 : 1);
