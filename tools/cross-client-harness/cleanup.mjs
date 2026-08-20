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

/** The one shape a check's venue can have. Anything else is somebody's real community. */
const DEBRIS = /^C\d+ COMM\d+-[0-9a-z]+$/;

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
