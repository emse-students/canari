/**
 * WHAT COUNTS AS THE APP ANSWERING A CLICK ON A CONVERSATION TILE.
 *
 * SPLIT OUT OF `syncrows.mjs` FOR THE REASON `servable.mjs` WAS: these four values decide a campaign
 * verdict, so they owe a self-test, and a self-test in the CI gate must be importable on a machine
 * with no rig. `syncrows.mjs` reaches `names.mjs`, which is gitignored because this repository is
 * PUBLIC and that file holds real display names - so nothing importing it can be in the gate.
 *
 * BOTH FAULTS ENCODED HERE PRODUCE A NUMBER RATHER THAN AN ERROR, which is why they are values with
 * a test rather than conditions written at the call site. A probe whose post-condition is "a composer
 * exists somewhere on the page" is satisfied by a client that already had a conversation open; a
 * probe that clicks the tile already selected is satisfied by a no-op. Each hands back a real-looking
 * millisecond count for a click that did nothing, and a verdict computed from it is indistinguishable
 * from a measurement.
 */

/**
 * The ready row `navigationCost` opens - never one already open, which no click can move.
 *
 * Scoped to `.sidebar-panel` because a document-wide match hits the posts mini-panel, which renders
 * the same component; keyed on `data-ready` rather than on the "Sync" badge, because that badge is a
 * Paraglide message and counting it counts the translation.
 */
export const READY_TILE =
  '.sidebar-panel [data-conversation-tile][data-ready="true"]:not([data-selected="true"])';

/**
 * The syncing row `amberListCost` clicks.
 *
 * A REMOVED tile is excluded deliberately: it is dead rather than in transit, it shows no badge, and
 * clicking it asks HEAL-NEW-7's question instead of this one.
 */
export const SYNCING_TILE =
  '.sidebar-panel [data-conversation-tile][data-ready="false"]:not([data-removed="true"]):not([data-selected="true"])';

/**
 * A ready row has no excuse: the list must select it AND the conversation must render.
 *
 * @param seen `{ selected, opened }` read off the clicked tile and the page - `selected` is `null`
 * when the tile has left the sidebar, which is neither true nor false and must not read as either.
 */
export const OPENED = (seen) => seen.selected === true && seen.opened === true;

/**
 * A syncing row may decline to render - there is no MLS state to render - but it may not leave the
 * list unmoved. That difference is the entire distinction between the two halves of HEAL-NEW-15.
 */
export const REACTED = (seen) => seen.selected === true || seen.opened === true;
