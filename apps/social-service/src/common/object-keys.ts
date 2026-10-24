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

/**
 * `record` with `key` set to `value`, as a NEW prototype-less map - the write for a key that came
 * off a request.
 *
 * A plain `map[key] = value` with such a key is what a remote-property-injection analysis flags,
 * and it cannot see that the key was refused upstream. Going through a `Map` and
 * `Object.fromEntries` defines own data properties only (never a setter, never a prototype walk),
 * and the result is copied onto `Object.create(null)` as before. The refusal still belongs where
 * the key enters; this throws only if a caller skipped it.
 *
 * @throws TypeError for an unsafe key - a caller bug, never a user's answer.
 */
export function withOwnEntry<V>(
  record: Record<string, V> | null | undefined,
  key: string,
  value: V
): Record<string, V> {
  if (isUnsafeObjectKey(key)) throw new TypeError('withOwnEntry: unsafe key refused');
  const entries = new Map<string, V>(
    Object.entries(record ?? {}).filter(([k]) => !isUnsafeObjectKey(k))
  );
  entries.set(key, value);
  return Object.assign(Object.create(null) as Record<string, V>, Object.fromEntries(entries));
}
