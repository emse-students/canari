/**
 * THE KEYS A USER-SUPPLIED STRING MAY NEVER BECOME, IN ONE PLACE.
 *
 * Four sites wrote this list out - `addReaction`, `removeReaction`, `sanitizeReactions` and the
 * channel poll's vote - and they did not agree: three names in three of them, five in the fourth,
 * with `__defineGetter__` and `__defineSetter__` present in exactly one. A list that differs by
 * site is a list that is wrong at every site but one, and nothing would have failed if a fifth had
 * been written with two.
 *
 * `Object.create(null)` answers HALF of this and is still used wherever such a map is built: a
 * prototype-less object has nothing to walk into. What it does not stop is the map CARRYING a key
 * of this shape, which then travels to every reader of that map and to JSON. So the identifier is
 * refused where it enters, and skipped where a map is rebuilt from stored data that may predate
 * the refusal.
 *
 * @see forms.service.ts, which reaches the same conclusion from the other direction: an allowlist
 * of declared ids is what settles it when one exists.
 */
const UNSAFE_OBJECT_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
];

/**
 * Whether this string would shadow something if used as a property name.
 *
 * @param key The candidate key - a user id, a question id, anything off a request.
 * @returns `true` when it must be refused or skipped rather than written.
 */
export function isUnsafeObjectKey(key: string): boolean {
  return UNSAFE_OBJECT_KEYS.includes(key);
}
