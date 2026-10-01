/**
 * WHICH PHONE PLATFORM A RUN DRIVES - `CANARI_PHONE=android` (the default) or `CANARI_PHONE=ios`.
 *
 * Pure, and its own module for one reason: `phone-any.mjs` decides with it BEFORE importing either
 * implementation, and the gated self-test must be able to ask the question without importing
 * `phone.mjs`, which reaches the gitignored `names.mjs`.
 *
 * AN UNKNOWN VALUE IS REFUSED, never read as the default. `CANARI_PHONE=iphone` silently driving the
 * Mi 9T would record an Android verdict under a run that believes it measured an iPhone.
 */

export const PLATFORMS = Object.freeze(['android', 'ios']);

/**
 * The platform named by `value` (normally `process.env.CANARI_PHONE`).
 *
 * @param {string | undefined} value unset or empty means `android`, the rig's historical phone
 * @returns {'android' | 'ios'}
 */
export function phonePlatform(value = process.env.CANARI_PHONE) {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return 'android';
  if (!PLATFORMS.includes(v)) {
    throw new Error(`CANARI_PHONE=${value} names no phone platform - use one of: ${PLATFORMS.join(', ')}`);
  }
  return v;
}

/** `I1`, `I2`, ... - the rig's spelling for "this client is the iOS app", beside `A*` for Android. */
export const isIosName = (name) => /^I\d+$/.test(name ?? '');
