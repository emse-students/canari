/**
 * Deletes the communities, the salons AND the throwaway GROUPS a CRASHED check left on THE ESTATE
 * `SITE` NAMES - the local estate or dev, never production (R1 refuses it).
 *
 *   bun cleanup.mjs [--dry]
 *   bun cleanup.mjs --only <id>[,<id>...] --expect N     # REQUIRED on dev (R5)
 *
 * ON DEV, ONLY WHAT THE CAMPAIGN CREATED, AND ONLY WHAT THE CALLER NAMED (R5, 2026-10-24). Dev is
 * shared with testers, so a matching NAME is not ownership there: a candidate must also be in the
 * campaign ledger (`campaign.mjs`), and the sweep acts only on the ids `--only` names, refusing the
 * whole sweep when `--expect` differs or a named id is no longer a candidate. `--dry` prints the
 * exact `--only ... --expect N` line for what it would take. On the local estate both flags stay
 * optional and the name allowlists decide, as before.
 *
 * THREE ESTATES, NOT ONE, and for a while this swept only the first. A runner that builds its own
 * community takes it down with it, so debris there is rare - but most checks build a SALON inside the
 * shared venue `VENUE` names, and a shared venue is never deleted, so every salon a crashed
 * runner left sits there for ever. Measured 2026-08-21: 25 salons in that one community, 23 of them
 * from COMM runs, against a sweep reporting "nothing to sweep". That is not cosmetic. The channel
 * list grows downward, and at 25 rows the community's own "add a channel" control sat at y=1149 in a
 * 944-tall viewport - below the fold, unclickable, which is how COMM-14 failed: the check could not
 * build its venue, in a community whose only problem was the debris of the checks before it.
 *
 * WHY THIS EXISTS AT ALL, given every runner deletes its own venue. Because a runner that dies
 * mid-way does not: COMM-6 threw on a bad query on 2026-08-20 and left `C6 COMM6-mt1gh7hx4it`
 * behind, with its distribution group and its member. One is harmless; a phase of twenty-five rows
 * re-run through a week of fixes is not, and the campaign's first requirement is a venue whose
 * contents are all accounted for.
 *
 * **AN ALLOWLIST, NEVER A DENYLIST**, and here the NAME is the allowlist. Every venue a check builds
 * is named `C<n> COMM<n>-<mark>`, where the mark is minted by `results.mjs` and cannot collide with
 * anything a person would type. Nothing else is eligible - not the shared venue itself, not
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
import { client, openChannel } from './chat.mjs';
import { deleteChannel, deleteCommunity, enterCommunities, openCommunity } from './comm.mjs';
import { isCommunityDebris, isGroupDebris } from './debris.mjs';
import { deleteGroup } from './groupnav.mjs';
import { planCampaignSweep } from './campaign.mjs';
import { sweepArgs } from './campaign-ledger.mjs';
import { psql } from './estate.mjs';
import { PORTS, VENUE } from './names.mjs';
import { SITE } from './site.mjs';

/**
 * AN ALLOWLIST, and it is only as good as its enumeration. COMM-12 builds TWO venues per run and
 * names the arm in between - "C12 shared COMM12-<mark>" - which the single shape did not match, so
 * every run of it left a community behind that no sweep would ever take. Found 2026-08-20 with four
 * of seven communities matching and a fifth sitting there in plain sight. Widen this by ENUMERATING
 * what the runners mint, never by relaxing it: the price of a loose pattern here is a real
 * community, typed name and all, and there is no undo. The list is `debris.mjs`'s
 * `COMMUNITY_DEBRIS`, beside the group one, so `debris-selftest.mjs` pins both.
 */

/**
 * THE SAME ALLOWLIST, FOR THE OTHER ESTATE, and enumerated from the runners rather than guessed:
 * every one of them mints `c<n>-` plus its run mark lowercased, where the mark comes from
 * `mark('COMM<n>')` - giving `c8-comm8-<mark>` - and COMM-12 alone inserts its arm, as
 * `c12-private-comm12-<mark>`. The mark is minted by `results.mjs` and cannot collide with anything
 * a person would type.
 *
 * A salon whose name does not match is LEFT, listed, and looked at by a human. Two such sat in the
 * venue the day this was written - `rep-repair-<mark>` from a scratch probe, and `g3-priv-a` - and
 * neither is minted by anything still in this repo, so neither may be swept by a shape derived from
 * what is. Widening this to reach them would mean widening it far enough to reach a real salon.
 */
const SALON_DEBRIS = /^c\d+(-[a-z]+)?-comm\d+-[0-9a-z]+$/;

/** The community every check that does not build its own venue works inside. Never deleted. */
/**
 * THE THIRD ESTATE: the throwaway DM GROUPS checks build, whose allowlist now lives in
 * `debris.mjs` because `dismiss.mjs` sweeps the CLIENT-SIDE half of the same estate and the two
 * must never disagree about what may be destroyed.
 *
 * Every one of these deletes its own group as its last act, so debris here is a check that DIED -
 * and for READ-10 the deletion IS the stimulus, which makes a mid-run death leave a LIVE group
 * rather than a tombstone. Measured on prod 2026-08-21: twenty-five throwaway groups from every
 * phase that has ever built one, twenty-three of them tombstoned as designed, and TWO alive - both
 * `READ10-*`, from the two runs that died at the invite step while that check was being repaired.
 *
 * A TOMBSTONE IS NOT DEBRIS AND IS NOT TOUCHED HERE. It is what a deleted group is supposed to look
 * like, the 90-day reaper owns it, and a sweep that "cleaned up" tombstones would be destroying the
 * record of every check that worked. Only `deletedAt IS NULL` is eligible. The copy a tombstone
 * leaves on each MEMBER'S CLIENT is a different estate with a different owner - `dismiss.mjs`.
 */

// THE SHARED VENUE IS WHATEVER `VENUE` NAMES, AND A LITERAL HERE SWEPT THE WRONG COMMUNITY. This
// said `'Campagne de test'` until 2026-09-04; on an estate seeded from a production dump that is a
// REAL community belonging to two production users, so the salon sweep enumerated a place no check
// had ever written to and reported "0 match a check's venue" - which the comment above calls out by
// name as the failure mode of an allowlist. Nothing was wrongly deleted, because `SALON_DEBRIS`
// gates every deletion; what was lost is the sweep itself, silently.
const SHARED = VENUE.community;

const dry = process.argv.includes('--dry');

const named = psql(`SELECT id, name FROM channel_workspaces ORDER BY "createdAt"`)
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const at = line.indexOf('|');
    return { id: line.slice(0, at), name: line.slice(at + 1) };
  });

let debris = named.filter((w) => isCommunityDebris(w.name));

// NAMES THE ESTATE, because this file DELETES. It said "on production" unconditionally while
// routing through `estate.mjs`, which picks the local containers or production from `SITE` - so on
// the local estate every line of this destructive tool's output named the wrong box. A reader
// deciding whether a sweep is safe reads exactly this line.
console.log(
  `[cleanup] ${named.length} communities on ${SITE}, ${debris.length} match a check's venue`
);
for (const w of debris) console.log(`  ${w.id.slice(0, 8)}  ${w.name}`);

// WHAT IT DID NOT MATCH IS THE HALF WORTH READING, and it used to print nothing at all. An
// allowlist is only as good as its enumeration, so its failure mode is a venue sitting in plain
// sight while the sweep reports success - "0 match a check's venue" reads as "the estate is clean"
// and means "I recognised nothing". It has happened twice: COMM-12's second venue on 2026-08-20,
// and a scratch probe on 2026-08-21 that minted `C22 PROBE-<mark>` outside the shape. Naming the
// rest costs one line and makes the next escape visible on the run that causes it. These are REAL
// communities, so they are listed and never touched.
const strangers = named.filter((w) => !isCommunityDebris(w.name));
if (strangers.length > 0) {
  console.log(`[cleanup] ${strangers.length} NOT matched - left alone, check none of these is debris:`);
  for (const w of strangers) console.log(`  ${w.id.slice(0, 8)}  ${w.name}`);
}

// THE SALONS OF THE SHARED VENUE. Read from the database for the same reason the communities are:
// the sidebar is the thing this debris BREAKS, so a sweep enumerating from the screen would go blind
// at exactly the size that makes it necessary.
const shared = named.find((w) => w.name === SHARED);
/** `id|name` rows of a query, as objects. */
const idNameRows = (out) =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf('|');
      return { id: line.slice(0, at), name: line.slice(at + 1) };
    });
const salonRows = shared
  ? idNameRows(psql(`SELECT id, name FROM channels WHERE "workspaceId" = '${shared.id}' ORDER BY "createdAt"`))
  : [];
const salons = salonRows.map((r) => r.name);
let salonDebris = salons.filter((n) => SALON_DEBRIS.test(n));
const salonStrangers = salons.filter((n) => !SALON_DEBRIS.test(n));

if (shared) {
  console.log(
    `[cleanup] ${salons.length} salons in "${SHARED}", ${salonDebris.length} match a check's venue`
  );
  for (const n of salonDebris) console.log(`  ${n}`);
  if (salonStrangers.length > 0) {
    console.log(
      `[cleanup] ${salonStrangers.length} salon(s) NOT matched - left alone, look at these:`
    );
    for (const n of salonStrangers) console.log(`  ${n}`);
  }
}

// THE LIVE ONES ONLY. A tombstoned group is a check that worked; deleting the record of that would
// be the sweep destroying evidence rather than debris.
const liveGroupRows = idNameRows(psql(`SELECT id, name FROM dm_groups WHERE "deletedAt" IS NULL ORDER BY "createdAt"`));
let groupDebris = liveGroupRows.map((r) => r.name).filter(isGroupDebris);
if (groupDebris.length > 0) {
  console.log(`[cleanup] ${groupDebris.length} live throwaway group(s) - a check died before its own delete:`);
  for (const n of groupDebris) console.log(`  ${n}`);
}

/**
 * THE STORES THIS SWEEP DOES NOT LOOK AT, COUNTED RATHER THAN NAMED.
 *
 * "nothing to sweep" reads as "the estate is clean" and means "the three stores I own are clean".
 * That is the same gap the community and salon reports above were widened to close, one level up:
 * an all-clear about a narrower question than the one the reader is asking. So the scope is printed
 * on every run, with a live count, and a reader can see for themselves whether it matters today.
 *
 * **NEITHER ENTRY IS A SWEEP WAITING TO BE WRITTEN.** Each was considered and REFUSED, and the
 * reason is the allowlist rule this file is built on - a destructive control names what it MAY
 * touch, and neither of these can be named that way.
 *
 * `queued_message` is the delivery queue. 13 275 rows had accumulated behind dead throwaway devices
 * by 2026-09-08, which is the count this was first written for. **Re-measured 2026-09-24: the local
 * estate holds 4, from ONE device, all minted that day** - the estate has been re-seeded since, so
 * the population the clause would have been written against no longer exists, and what is there now
 * belongs to a LIVE device whose undelivered messages a sweep would destroy. There is also no
 * product gesture that deletes a queue row and no table on this estate that enumerates devices, so
 * an allowlist could only be built as a denylist. Retention is 90 days and it expires on its own.
 *
 * `associations` holds check R's notification fixture - an association with a logo, the only
 * fixture-reachable feeder of a notification's large icon (`docs/wiki/device-verification.md`). It
 * is built BY HAND and reused across runs, so deleting it would cost the next run its fixture
 * rather than save it anything. It is not debris; it is equipment.
 */
const UNSWEPT = [
  {
    store: 'queued_message',
    sql: 'SELECT count(*) FROM queued_message',
    why: 'the delivery queue - a live device owns undelivered rows, and 90-day retention expires the rest',
  },
  {
    store: 'associations',
    sql: 'SELECT count(*) FROM associations',
    why: "check R's notification fixture - built by hand and reused, equipment rather than debris",
  },
];

console.log('[cleanup] NOT looked at by this sweep, and deliberately so:');
for (const { store, sql, why } of UNSWEPT) {
  const count = psql(sql).trim() || '(unreadable)';
  console.log(`  ${store}: ${count} row(s) - ${why}`);
}

if (debris.length === 0 && salonDebris.length === 0 && groupDebris.length === 0) {
  console.log('[cleanup] nothing to sweep in the three stores this file owns - communities, salons, groups');
  process.exit(0);
}
// THE ALLOWLIST BY ID, AND ON DEV THE OWNERSHIP (R5). The name shapes above chose the candidates;
// `planCampaignSweep` decides which of them this run may take - on dev only the ids the caller
// named, each campaign-owned, with the count it expected. Anything refused stops the WHOLE sweep.
const candidates = [
  ...debris.map((w) => ({ kind: 'community', id: w.id, name: w.name })),
  ...salonRows
    .filter((r) => salonDebris.includes(r.name))
    .map((r) => ({ kind: 'salon', id: r.id, name: r.name, parent: SHARED })),
  ...liveGroupRows.filter((r) => groupDebris.includes(r.name)).map((r) => ({ kind: 'group', id: r.id, name: r.name })),
];
const plan = planCampaignSweep({ candidates, ...sweepArgs(process.argv) });
if (!plan.ok) {
  for (const r of plan.refusals) console.log(`[cleanup] REFUSED: ${r}`);
  console.log(
    `[cleanup] to take every candidate, after reading the list above: ` +
      `--only ${candidates.map((c) => c.id).join(',')} --expect ${candidates.length}`
  );
  if (dry) {
    console.log('[cleanup] --dry: nothing deleted');
    process.exit(0);
  }
  process.exit(1);
}
const taken = new Set(plan.targets.map((t) => `${t.kind}:${t.name}`));
debris = debris.filter((w) => taken.has(`community:${w.name}`));
salonDebris = salonDebris.filter((n) => taken.has(`salon:${n}`));
groupDebris = groupDebris.filter((n) => taken.has(`group:${n}`));
for (const c of plan.left) console.log(`[cleanup] not named by --only, LEFT: ${c.kind} ${c.name} (${c.id})`);
if (dry) {
  console.log(`[cleanup] --dry: nothing deleted; would take ${plan.targets.length}`);
  process.exit(0);
}

const w1 = await client(PORTS.W1);
const failed = [];

// SALONS FIRST, COMMUNITIES SECOND. A community's deletion takes its salons with it, so the other
// order would walk a sidebar whose rows are vanishing underneath it - and the salons are the half
// that unblocks the next run.
for (const n of salonDebris) {
  try {
    await openChannel(w1, SHARED, n);
    await deleteChannel(w1);
    console.log(`[cleanup] deleted salon ${n}`);
  } catch (e) {
    failed.push(`salon ${n}: ${e instanceof Error ? e.message : String(e)}`);
    console.log(
      `[cleanup] COULD NOT delete salon ${n} - ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

// GROUPS BEFORE COMMUNITIES AND AFTER SALONS: a group is unrelated to either estate, and doing it
// while the sidebar is still whole is simply cheaper than doing it after two rounds of deletions have
// re-sorted the list.
//
// FROM EITHER BROWSER, because which one may delete a group is a property of the GROUP: the creator
// varies by check - READ-10 builds on W2, `del1.mjs` on W1 - and `deleteGroup` answers 'not listed'
// rather than throwing when this client does not have it, which makes trying both the whole logic.
const w2 = groupDebris.length > 0 ? await client(PORTS.W2) : null;
for (const n of groupDebris) {
  let done = false;
  for (const [who, cx] of [
    ['W1', w1],
    ['W2', w2],
  ]) {
    if (!cx || done) continue;
    try {
      if ((await deleteGroup(cx, n)) === 'deleted') {
        console.log(`[cleanup] deleted group ${n} from ${who}`);
        done = true;
      }
    } catch (e) {
      console.log(`[cleanup] ${who} could not delete group ${n} - ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!done) failed.push(`group ${n}: neither browser could delete it`);
}
if (w2) w2.close();

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
  .filter((l) => isCommunityDebris(l));

const salonsLeft = shared
  ? psql(`SELECT name FROM channels WHERE "workspaceId" = '${shared.id}'`)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => SALON_DEBRIS.test(l))
  : [];

const groupsLeft = psql(`SELECT name FROM dm_groups WHERE "deletedAt" IS NULL`)
  .split('\n')
  .map((l) => l.trim())
  .filter(isGroupDebris);

console.log(
  `[cleanup] communities ${debris.length - left.length}/${debris.length} swept, ${left.length} left`
);
console.log(
  `[cleanup] groups ${groupDebris.length - groupsLeft.length}/${groupDebris.length} swept, ` +
    `${groupsLeft.length} left`
);
console.log(
  `[cleanup] salons ${salonDebris.length - salonsLeft.length}/${salonDebris.length} swept, ` +
    `${salonsLeft.length} left`
);
for (const name of [...left, ...salonsLeft]) console.log(`  still there: ${name}`);
for (const f of failed) console.log(`  failure: ${f}`);

w1.close();
process.exit(left.length === 0 && salonsLeft.length === 0 ? 0 : 1);
