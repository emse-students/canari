/**
 * THE ONE ALLOWLIST OF THROWAWAY GROUP NAMES, shared by every sweep that may delete one.
 *
 * It lived inside `cleanup.mjs` while only that file swept groups. `dismiss.mjs` now needs the same
 * list for the OTHER HALF of the same estate - the client-side copy a tombstone leaves behind - and
 * `cleanup.mjs` cannot be imported to get it, because importing a script runs its sweep. The choice
 * was therefore a module or a second copy, and `cleanup.mjs` says what a second copy costs: "Widen
 * this by ENUMERATING what the runners mint, never by relaxing it: the price of a loose pattern here
 * is a real community, and there is no undo." Two allowlists disagreeing about what may be destroyed
 * is that same defect with a longer fuse.
 *
 * Enumerated from the runners that mint them, never guessed: `READ10-<mark>` (read.mjs),
 * `DEL1-<mark>` (del1.mjs), `HGRP<5>` (heal-w2.mjs), `HEALW2-<mark>` (newgroup.mjs's default),
 * `GRP<n>-<mark>` (grp.mjs). The mark is minted by `results.mjs` from `Date.now()` in base 36 plus a
 * random tail, so nothing a person would type can collide with one.
 */
export const GROUP_DEBRIS = [
  /^READ10-[0-9a-z]+$/,
  /^DEL\d*-[0-9a-z]+$/,
  /^HGRP[0-9a-z]{4,6}$/,
  /^HEALW2-[0-9a-z]+$/,
  // `-R` is GRP-5's, and it is the reason this list was measured rather than copied: that check
  // RENAMES its group to `<name>-R` (grp.mjs:702) to prove a rename is a broadcast, and the pattern
  // without the suffix matched neither the renamed group nor the tombstone it leaves. Twenty-two of
  // them were sitting in W2's store on 2026-08-24, invisible to both sweeps - the server-side one
  // would equally have spared a LIVE `GRP5-*-R` from a run that died between the rename and the
  // teardown. Enumerated from the runner; `grep -n renameGroup *.mjs` says it is the only one.
  /^GRP\d+-[0-9a-z]+(-R)?$/,
];

/** True when `name` is a group a runner minted, and therefore a group a sweep may delete. */
export const isGroupDebris = (name) => GROUP_DEBRIS.some((r) => r.test(name));
