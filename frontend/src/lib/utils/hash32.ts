/**
 * A cheap, synchronous, well-mixed 32-bit hash of a string: FNV-1a over the low byte of each code
 * unit, then MurmurHash3's finaliser.
 *
 * NOT A CRYPTOGRAPHIC DIGEST, and never used as one: its callers only need an even, reproducible
 * SPREAD of ids - which slice an id is compared in (`historyRangeOf`), which day of the week a
 * device first refreshes its leaf in a group (`leafRefreshOffsetMs`). A collision or an uneven
 * spread there costs bandwidth or a lumpier schedule, never correctness.
 *
 * THE FINALISER IS NOT OPTIONAL. FNV-1a alone leaves its HIGH bits barely mixed for short, similar
 * inputs, and both callers read exactly those bits: measured, 64 ids differing only in a trailing
 * counter landed in 5 of 16 slices without it.
 *
 * PART OF A PROTOCOL: two devices that hash the same id must agree, so the byte reading (`& 0xff`)
 * and the constants are frozen.
 */
export function mixedHash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}
