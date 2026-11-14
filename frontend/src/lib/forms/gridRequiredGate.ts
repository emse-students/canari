import { serverGridRequiredSwitch } from '$lib/stores/appVersionCheck.svelte';

/**
 * WHETHER THIS ESTATE STORES EACH PRICED GRID'S OWN "OBLIGATOIRE" SWITCH (owner, 2026-11-13) - the
 * one gate the editor, the payload and both fill pages read.
 *
 * `true` only when `/api/version` said `gridRequiredSwitch: true`. Until then - an estate older than
 * the switch, or no answer yet - this build behaves as the build before it ([LEGACY],
 * docs/wiki/legacy-compatibility.md, "a form editor or fill page newer than its server's priced
 * grids"): the editor sends every grid `required: true` without the marker and draws no switch, and
 * the fill pages ignore a grid's flag and hold an answer whose visible grids hold no unit between
 * them (the server's `PRODUCT_GRID_EMPTY`). A store build reaches phones days before production
 * deploys; sending an optional grid to that server is refused `PRODUCT_GRID_NOT_REQUIRED`.
 */
export function gridRequiredSwitchOn(): boolean {
  return serverGridRequiredSwitch() === true;
}
