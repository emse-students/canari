/**
 * The subset rule that decides HEAL-NEW-2 and -12, exercised on the sidebars it has to tell apart.
 *
 * IT EXISTS BECAUSE THIS PREDICATE DECIDES A VERDICT. `subsetSettled` is the termination proof of a
 * campaign row: whatever it calls settled becomes `PASS` on a public board. The two ways it can be
 * wrong are not symmetric - refusing a healed subset costs a re-run, while accepting an EMPTY one
 * turns the one row that cannot be observed into the fastest PASS the board has ever recorded. That
 * asymmetry is the reason the emptiness case below is the first one written.
 *
 * AND BECAUSE THE RULE HAS A FACT INSIDE IT THAT NO TYPE CAN CARRY. A responder only serves groups it
 * belongs to; the owner holds ELEVEN and the peer shares TWO (`dm_device_group_memberships`,
 * 2026-08-28). So "every row healed" is unreachable on a peer-responder row however correct the app
 * is, and "every row the responder could serve, healed" is the same claim narrowed. A test is where
 * that narrowing stays honest: the amber rows OUTSIDE the subset must not block a pass, and the
 * amber rows INSIDE it must.
 *
 * THE IDS ARE FULL IDS HERE, DELIBERATELY. The last case asserts the join is exact - an eight
 * character prefix is enough to compare two reads of one browser and not enough to join two, and a
 * collision would put a group the responder is not in INTO the subset and demand a heal nothing
 * online could serve. That is a false FAIL, the one direction a rig must never round towards.
 */
import { splitBySubset, subsetArrivedAndSettled, subsetSettled } from "./servable.mjs";

/** A sidebar read as `syncrows.mjs` returns one: the counts, plus per-tile identity. */
function sidebar(tiles, { panel = true, unhooked = 0 } = {}) {
  return {
    panel,
    rows: tiles.length,
    ready: tiles.filter((t) => t.ready).length,
    syncing: tiles.filter((t) => !t.ready && !t.removed).length,
    removed: tiles.filter((t) => t.removed).length,
    unhooked,
    tiles,
  };
}

const tile = (id, ready, removed = false) => ({ id, ready, removed });

// Two full ids sharing their first eight characters, which is what `cut()` would keep.
const MINE = "1f4c8a20-0000-4000-8000-000000000001";
const THEIRS = "1f4c8a20-ffff-4000-8000-000000000002";
const OTHER = "9b7e1155-0000-4000-8000-000000000003";

let bad = 0;
const check = (what, got, want) => {
  if (got === want) console.log(`  ok   ${what}`);
  else {
    console.error(`  FAIL ${what} -> ${got}, wanted ${want}`);
    bad++;
  }
};

// --- the emptiness refusal, first, because it is the one that would fabricate a PASS ------------
check(
  "an empty subset is NOT settled, though every() over nothing is true",
  subsetSettled(new Set([THEIRS]))(sidebar([tile(MINE, false), tile(OTHER, false)])),
  false,
);
check(
  "a subset whose only group was DELETED is empty, not satisfied",
  subsetSettled(new Set([MINE]))(sidebar([tile(MINE, false, true), tile(OTHER, true)])),
  false,
);

// --- the narrowing itself ----------------------------------------------------------------------
check(
  "the subset healed while rows nobody online can serve stay amber -> settled",
  subsetSettled(new Set([MINE]))(sidebar([tile(MINE, true), tile(OTHER, false), tile(THEIRS, false)])),
  true,
);
check(
  "one amber row INSIDE the subset holds the row open",
  subsetSettled(new Set([MINE, OTHER]))(sidebar([tile(MINE, true), tile(OTHER, false)])),
  false,
);
check(
  "a whole sidebar inside the subset, all ready -> settled",
  subsetSettled(new Set([MINE, OTHER]))(sidebar([tile(MINE, true), tile(OTHER, true)])),
  true,
);

// --- the guards the whole-sidebar proof also carries, kept rather than assumed ------------------
check(
  "an unreadable panel is never settled",
  subsetSettled(new Set([MINE]))(sidebar([tile(MINE, true)], { panel: false })),
  false,
);
check("a sidebar with no rows at all is not a heal", subsetSettled(new Set([MINE]))(sidebar([])), false);
check(
  "unhooked > 0 voids the count, so it voids the subset too",
  subsetSettled(new Set([MINE]))(sidebar([tile(MINE, true)], { unhooked: 2 })),
  false,
);
// A tile with no `data-conversation-tile` is exactly what an UNDEPLOYED frontend produces, and it
// must read as outside the subset rather than as a match on `null`.
check(
  "a tile carrying no id is outside the subset, never in it",
  subsetSettled(new Set([MINE]))(sidebar([tile(null, true), tile(MINE, true)])),
  true,
);
check(
  "a sidebar of nothing BUT unhooked tiles leaves the subset empty",
  subsetSettled(new Set([MINE]))(sidebar([tile(null, true), tile(undefined, true)])),
  false,
);

// --- the split, which is what the ledger records ------------------------------------------------
{
  const s = splitBySubset([tile(MINE, true), tile(OTHER, false), tile(THEIRS, false, true), tile(null, true)], new Set([MINE, THEIRS]));
  check("the split puts the member row in the subset", s.inTheSubset.map((t) => t.id).join(","), MINE);
  check(
    "a removed member and a non-member and an unhooked tile are all outside",
    s.outside.map((t) => t.id ?? "null").join(","),
    `${OTHER},${THEIRS},null`,
  );
}

// --- the join is exact ---------------------------------------------------------------------------
check(
  "an id sharing eight characters with a member is NOT a member",
  splitBySubset([tile(THEIRS, false)], new Set([MINE])).inTheSubset.length,
  0,
);
check(
  "and the prefixes really do collide, or the case above proves nothing",
  MINE.slice(0, 8) === THEIRS.slice(0, 8),
  true,
);

// --- ARRIVAL, the second predicate, whose unknown is presence and not colour ---------------------
// EACH CASE HERE IS ONE THE LOOSE PREDICATE GETS WRONG OR WOULD GET WRONG, which is the only reason
// a second rule is allowed to exist. A device coming back from a wipe starts with an EMPTY sidebar.
check(
  "a device holding one owed row of two has not arrived, though the row it holds is ready",
  subsetArrivedAndSettled(new Set([MINE, OTHER]))(sidebar([tile(MINE, true)])),
  false,
);
check(
  "and the loose predicate calls that same sidebar settled, which is the defect",
  subsetSettled(new Set([MINE, OTHER]))(sidebar([tile(MINE, true)])),
  true,
);
check(
  "every owed row present and ready IS arrival",
  subsetArrivedAndSettled(new Set([MINE, OTHER]))(sidebar([tile(MINE, true), tile(OTHER, true)])),
  true,
);
check(
  "a row that arrived but is still amber is not arrival",
  subsetArrivedAndSettled(new Set([MINE, OTHER]))(sidebar([tile(MINE, true), tile(OTHER, false)])),
  false,
);
check(
  "rows nobody owed do not stand in for the ones that never came",
  subsetArrivedAndSettled(new Set([MINE, OTHER]))(sidebar([tile(MINE, true), tile(THEIRS, true)])),
  false,
);
check(
  "an owed row DELETED on the device has not arrived - a dead row is not a heal",
  subsetArrivedAndSettled(new Set([MINE, OTHER]))(
    sidebar([tile(MINE, true), tile(OTHER, true, true)]),
  ),
  false,
);
check(
  "an empty owed set is refused, so a subject nothing could narrow cannot be the fastest PASS",
  subsetArrivedAndSettled(new Set())(sidebar([tile(MINE, true)])),
  false,
);
check(
  "an unhooked reader voids arrival exactly as it voids readiness",
  subsetArrivedAndSettled(new Set([MINE]))(sidebar([tile(MINE, true)], { unhooked: 2 })),
  false,
);

if (bad) {
  console.error(`[servable] ${bad} case(s) wrong`);
  process.exit(1);
}
console.log("[servable] clean - the subset rule refuses an empty subset and ignores what no responder could serve");
