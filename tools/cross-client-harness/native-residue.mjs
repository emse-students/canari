/**
 * WHAT of a phone's account state is still on disk, as a classification of paths.
 *
 * Its own module, and pure on purpose: `residue-selftest.mjs` pins this border and must run on a
 * fresh checkout, where `names.mjs` - which `phone.mjs` needs - does not exist. Reading the paths
 * off the device is `nativeResidue()` there; deciding what they MEAN is here.
 */

/**
 * The native paths that exist only because an account was signed in here. Mirrors
 * `KEPT_AT_TOP_LEVEL` in `src-tauri/src/commands/storage.rs` from the other side: that constant
 * says what a wipe must not touch, this one says what it must leave nothing of.
 *
 * `installer_package.txt` is ours too and is listed, so a wipe that keeps it is reported rather
 * than quietly tolerated: Kotlin rewrites it at the next `onCreate`, which is a repair and not a
 * reason to leave it behind. `logs/` is ours as well and is NOT here - see
 * `REWRITTEN_WHILE_RUNNING` below.
 */
const OUR_NATIVE = [
  /^mls[.]bin$/,
  /^mls_pending[.]db/,
  /^canari_.*[.]db/,
  /^graine_seeds[.]json$/,
  /^channel_keys[.]json$/,
  /^push_context[.]json$/,
  /^session-meta[.]json$/,
  /^oidc-state[.]json$/,
  /^fcm_token[.]txt$/,
  /^pending_push_secret[.]txt$/,
  /^keystore_ok[.]flag$/,
  /^native_flags[.]json$/,
  /^installer_package[.]txt$/,
  /^files[/]avatar_/,
  /^shared_prefs[/]canari_/,
  /^shared_prefs[/]keystore_aliases/,
];

/**
 * Ours, deleted by the wipe, and rewritten within milliseconds by the app that is still running -
 * so its presence afterwards says nothing about the account. Same argument as `PARAGLIDE_LOCALE` on
 * the web half: a store an app rewrites by being OBSERVED is evidence, never a criterion. The
 * content is what matters here and it is post-wipe lines, which is why the path is reported rather
 * than ignored.
 */
const REWRITTEN_WHILE_RUNNING = [/^logs[/]/];

/**
 * Cuts every long hex run down to eight characters, the convention the rest of this harness uses.
 * `canari_<userId>.db` and `avatar_<sha1>.jpg` both carry an identifier, and this output is read
 * into a PUBLIC repository.
 */
function shorten(path) {
  return path.replace(/[0-9a-f]{12,}/g, (h) => h.slice(0, 8));
}

/**
 * Splits a list of paths RELATIVE to `/data/data/<pkg>` into the ones that are a criterion and the
 * ones a running app rewrites. Separated from `nativeResidue` so `residue-selftest.mjs` can pin the
 * border without a phone: `OUR_NATIVE` is the constant a new native store gets forgotten in, and
 * the wipe on the other side of it has already shipped broken twice.
 *
 * @param relative - paths with the `/data/data/<pkg>/` prefix already stripped
 */
export function classifyNativePaths(relative) {
  const residue = relative.filter((r) => OUR_NATIVE.some((re) => re.test(r))).map(shorten);
  const rewritten = relative
    .filter((r) => REWRITTEN_WHILE_RUNNING.some((re) => re.test(r)))
    .map(shorten);
  return { residue: residue.length, paths: residue.sort(), rewritten: rewritten.sort() };
}

