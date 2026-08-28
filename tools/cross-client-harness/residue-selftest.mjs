/**
 * Pins the border between what a native wipe must leave nothing of and what it may leave.
 *
 * `OUR_NATIVE` in `phone.mjs` is the constant a native store gets FORGOTTEN in, and the wipe on the
 * other side of it - `KEPT_AT_TOP_LEVEL` in `src-tauri/src/commands/storage.rs` - has already
 * shipped broken twice for exactly that reason. The paths below are the real listing of a revoked
 * Pixel 6a on 2026-08-28, so a new store added to the app data directory without a line here fails
 * this rather than surviving a revocation in silence.
 *
 * No device needed, and no `names.mjs` either: the classifier is its own pure module, which is
 * what lets this run on a fresh checkout.
 */
import { classifyNativePaths } from "./native-residue.mjs";

let failures = 0;
function check(label, ok) {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${label}`);
  if (!ok) failures++;
}

// The account state that was really on disk after a revocation the app reported as complete.
const ACCOUNT = [
  "mls.bin",
  "mls_pending.db",
  "mls_pending.db-wal",
  "mls_pending.db-shm",
  "canari_d82cd2268993451edb547bdd7ff278447f6619f67d0d73a520897e54f0714df2.db",
  "graine_seeds.json",
  "channel_keys.json",
  "push_context.json",
  "pending_push_secret.txt",
  "session-meta.json",
  "oidc-state.json",
  "fcm_token.txt",
  "keystore_ok.flag",
  "native_flags.json",
  "installer_package.txt",
  "files/avatar_08f6ee82e9b85af747fb28e6a0157f2d7bb55b82.jpg",
  "shared_prefs/canari_push_prefs.xml",
  "shared_prefs/keystore_aliases.xml",
];

// What belongs to a framework, and what the wipe must therefore NOT be reported for keeping.
const NOT_OURS = [
  "app_webview",
  "app_webview/Default",
  "no_backup/androidx.work.workdb",
  "cache/WebView",
  "code_cache",
  "databases",
  "app_textures",
  "lib",
  "files/PersistedInstallation.W0RFRkFVTFRd.json",
  "files/generatefid.lock",
  "files/profileInstalled",
  "shared_prefs/com.google.android.gms.appid.xml",
  "shared_prefs/WebViewChromiumPrefs.xml",
  "shared_prefs/FirebaseHeartBeatW0RFRkFVTFRd.xml",
  "shared_prefs/AwOriginVisitLoggerPrefs.xml",
];

const ours = classifyNativePaths(ACCOUNT);
check(`every one of the ${ACCOUNT.length} account paths is a criterion`, ours.residue === ACCOUNT.length);

const theirs = classifyNativePaths(NOT_OURS);
check(
  "no framework path is reported as residue",
  theirs.residue === 0 && theirs.rewritten.length === 0,
);
if (theirs.residue !== 0) console.log(`         reported: ${JSON.stringify(theirs.paths)}`);

const mixed = classifyNativePaths([...ACCOUNT, ...NOT_OURS, "logs/Canari.log"]);
check("the log the running app rewrites is reported apart, not counted", mixed.residue === ACCOUNT.length && mixed.rewritten.length === 1);

check(
  "a clean device is an empty list, which is a claim that can be wrong out loud",
  classifyNativePaths(NOT_OURS).residue === 0,
);

// This output is read into a PUBLIC repository, and two of these paths carry an identifier.
const shortened = classifyNativePaths([
  "canari_d82cd2268993451edb547bdd7ff278447f6619f67d0d73a520897e54f0714df2.db",
  "files/avatar_08f6ee82e9b85af747fb28e6a0157f2d7bb55b82.jpg",
]).paths;
check(
  "every identifier is cut to eight characters",
  shortened.includes("canari_d82cd226.db") && shortened.includes("files/avatar_08f6ee82.jpg"),
);

// The one a phone measured on the WebView alone would have called clean.
check(
  "the WebView's own stores are not in this list at all - the other half owns them",
  classifyNativePaths(["app_webview/Default/Local Storage/leveldb"]).residue === 0,
);

if (failures > 0) {
  console.error(`[residue] ${failures} check(s) failed`);
  process.exit(1);
}
console.log("[residue] clean - the native border holds");
