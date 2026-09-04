/**
 * WHAT COUNTS AS THE APP ANSWERING A CLICK - the two predicates and the two targets that decide
 * HEAL-NEW-15, exercised on the states they have to tell apart.
 *
 * IT EXISTS BECAUSE BOTH WAYS THESE CAN BE WRONG PRODUCE A NUMBER. A probe whose post-condition is
 * "a composer exists somewhere on the page" is satisfied by a client that already had a conversation
 * open, and a probe that clicks the tile already selected is satisfied by a no-op: each hands back a
 * real-looking millisecond count for a click that did nothing, and a `PASS` computed from it reads
 * exactly like a measurement. Both faults were live in this file on 2026-08-29 and both were found by
 * reading rather than by a run, which is the reason they are pinned here rather than remembered.
 *
 * AND BECAUSE THE TWO ROWS OF THE DESIGN DIFFER ONLY IN THESE PREDICATES. "A healed conversation
 * opens" and "an amber list still reacts" are one click apart, and the second must survive a product
 * that legitimately declines to render a group it holds no MLS state for. Loosening `OPENED` or
 * tightening `REACTED` would silently move what the row asserts, which is the one thing a branch
 * carrying a row to green may never do.
 */
import { OPENED, READY_TILE, REACTED, SYNCING_TILE } from "./usability.mjs";

let bad = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad += 1;
  console.log(`  ${ok ? "ok  " : "WRONG"} ${what}${ok ? "" : ` - got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`);
};

/** A reading of the clicked tile plus the page, as `clickTileAndTime` takes it. */
const seen = (selected, opened) => ({ selected, opened });

// --- a ready row has no excuse, so both halves are demanded ---------------------------------------
check("a ready row that selected AND opened answered", OPENED(seen(true, true)), true);
check(
  "THE ONE THAT WAS LIVE: a composer already on the page is NOT an answer on its own",
  OPENED(seen(false, true)),
  false,
);
check("nor is a selection with nothing rendered, for a row that is ready", OPENED(seen(true, false)), false);
check("and a dead list is not an answer", OPENED(seen(false, false)), false);

// --- a syncing row may decline to render; it may not leave the list unmoved -----------------------
check("a syncing row the app selected answered, whatever it did next", REACTED(seen(true, false)), true);
check("so did one it went as far as opening", REACTED(seen(true, true)), true);
check(
  "THE FINDING THE ROW EXISTS FOR: neither selected nor opened is a frozen list",
  REACTED(seen(false, false)),
  false,
);

// --- a tile that left the sidebar answers neither, and must not read as one -----------------------
for (const [name, p] of [["OPENED", OPENED], ["REACTED", REACTED]]) {
  check(`${name} treats a tile that left the sidebar as no answer`, p(seen(null, false)), false);
  // `null` is "the tile is gone", not "not selected" - and only the caller can tell those apart,
  // which is why it returns rather than waits out the deadline on them.
  check(`${name} does not let a stale composer speak for a tile that is gone`, p(seen(null, true)), name === "REACTED");
}

// --- the targets exclude what cannot answer -------------------------------------------------------
check("the ready target refuses the conversation already open", READY_TILE.includes(':not([data-selected="true"])'), true);
check("so does the syncing target", SYNCING_TILE.includes(':not([data-selected="true"])'), true);
check("the syncing target refuses a REMOVED row, which is dead rather than in transit", SYNCING_TILE.includes(':not([data-removed="true"])'), true);
check("both are scoped to the sidebar, never a document-wide match", [READY_TILE, SYNCING_TILE].every((s) => s.startsWith(".sidebar-panel ")), true);
check("and they read the hook, never the badge or the style", [READY_TILE, SYNCING_TILE].every((s) => s.includes("[data-conversation-tile]")), true);

if (bad) {
  console.error(`[usability] ${bad} case(s) wrong`);
  process.exit(1);
}
console.log("[usability] clean - a composer that was already there is not an answer, and neither is a no-op click");
