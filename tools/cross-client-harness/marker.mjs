/**
 * THE MARKER VOCABULARY: minting one, recognising one in rendered text, and decoding when it was
 * minted. Pure string work, no I/O, no configuration.
 *
 * IT LIVES APART FROM `results.mjs` BECAUSE A PURE FUNCTION MUST NOT NEED A MACHINE TO IMPORT.
 * `results.mjs` reads `SITE` and `STATE_DIR` from `names.mjs`, which is gitignored on purpose - it
 * holds real display names and this repository is PUBLIC. So importing `mark` used to require a file
 * CI does not have, and `debris-selftest.mjs` - which builds its names from `mark` precisely so that
 * the test and the allowlist are not one belief written twice - could not run in the gate. It failed
 * the CD run of `74e9e1ec` with `ERR_MODULE_NOT_FOUND: names.mjs`.
 *
 * `results.mjs` re-exports every name here, so no call site changed.
 */
/** A short unique marker, so two runs of the same check never collide in the history. */
export const mark = (id) => `${id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * The same marker with a sequence number, for a check that sends a RUN of messages.
 *
 * It exists because hand-rolled sequenced markers kept being written at the call site, and they
 * drifted from what `mark` produces in the one way that matters: `PEND-mson9mr-1041`, several
 * hundred of which are sitting in the test DM, carries a stamp `recon.mjs` cannot decode, so the
 * reconciliation excluded every one of them and reported success over an empty set. Producing the
 * sequence here keeps the stamp intact and the ordinal readable.
 */
export const markSeq = (id, n) => `${mark(id)}-${String(n).padStart(4, '0')}`;

/**
 * Recognises a campaign marker in rendered text - THE ONLY definition, imported by `recon.mjs`.
 *
 * Deliberately looser than what `mark` emits, because the history holds markers from checks written
 * before it existed (`NOTIF10-0-msi3g44rb9u`, `LIFE5B-abcde`, `PEND-<stamp>-1041`). Over-matching is
 * safe and under-matching is not: a token that is not really a marker appears in BOTH clients' text
 * and reconciles away, while a marker the pattern misses is a loss that cannot be seen. Anything
 * whose stamp will not decode is dropped from the comparison by `markerStamp` rather than reported.
 */
export const MARKER_RE = /\b[A-Z][A-Z0-9]{1,11}(?:-[0-9a-z]+){1,3}\b/g;

/** Wall time a marker was minted, or null when no segment of it decodes to a plausible one. */
export function markerStamp(marker) {
  for (const segment of marker.split('-').slice(1)) {
    // Either the whole segment (`mark` before the random suffix was added) or the segment with the
    // three random characters removed. Both are tried; the plausibility bound is what decides.
    for (const candidate of [segment, segment.slice(0, -3)]) {
      const t = parseInt(candidate, 36);
      if (Number.isFinite(t) && t > 1_700_000_000_000 && t < Date.now() + 60_000) return t;
    }
  }
  return null;
}
