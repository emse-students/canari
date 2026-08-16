/**
 * EVERY RULE OF THE PHONE CLASSIFIER, PINNED AGAINST A LINE WHOSE BUCKET IS KNOWN.
 *
 * The sibling of `srvclassify-selftest.mjs`, and it exists for the same reason: a classifier is only
 * worth its rules, and a rule nobody exercises rots silently. A regex that stops matching after a log
 * message is reworded does not fail - it quietly moves its lines into `unexplained`, or worse, out of
 * `severe`. Both are invisible until a run is read by hand.
 *
 * THE FIXTURES ARE SYNTHETIC BUT THE SHAPES ARE MEASURED. Every line below was written from a real
 * capture and then had its identifiers replaced, because the captures hold a display name, group ids
 * and message text from a REAL account and this repository is public. What is preserved is the only
 * thing a classifier reads: the tag, the severity, and the message prefix.
 *
 * Usage: node logcatclassify-selftest.mjs
 */
import { logcatReport } from './watch.mjs';

/** `[stamp] [pid] [tid] [sev] [tag]: msg` - adb's `threadtime`, which is what `logcatSince` gets. */
const line = (sev, tag, msg) => `08-16 12:00:00.000  4321  4321 ${sev} ${tag}: ${msg}`;

/**
 * `[fixture, expected bucket]`. `explained` means "claimed by a named rule and in no gating bucket";
 * `foreign` means "not this application, counted only".
 */
const CASES = [
  // ── ours, and benign: every EXPLAINED rule gets one ────────────────────────────────────────────
  [line('D', 'MainActivity', 'onPause: isInForeground=false'), 'explained'],
  [line('D', 'MlsDeviceKeyStore', 'retrieve: success alias=mls_device_key_0000'), 'explained'],
  [line('D', 'CanariApp', 'checkKeystoreHealth: Keystore operational'), 'explained'],
  [line('I', 'CanariApp', 'processPendingPushSecret: secret stored in the Keystore'), 'explained'],
  [line('D', 'CanariApp', 'recordInstallerPackage: installed by (none - sideload)'), 'explained'],
  [line('I', 'MainActivity', 'FCM token synced (abcd…)'), 'explained'],
  [line('D', 'CanariFCM', 'onMessageReceived: type=message action=null groupId=0000'), 'explained'],
  [line('D', 'CanariFCM', 'App in foreground -> MLS handled by the foreground (WS), skip'), 'explained'],
  [line('D', 'CanariFCM', 'decryptProto: success type=text -> "MARKER"'), 'explained'],
  [line('D', 'CanariFCM', 'showNotification: notifId=1 messages=1 group=false'), 'explained'],
  [line('D', 'CanariFCM', 'fetchAvatar: from cache for 0000'), 'explained'],
  [line('D', 'CanariFCM', 'drainOutboxBackground: 1 sent, 0 remaining'), 'explained'],
  [line('D', 'CanariWorker', 'resetFailureFlag: flag reset'), 'explained'],
  [line('I', 'mines_app_lib', '[mines_app_lib] [Path] app_data_dir = /data/user/0/fr.emse.canari'), 'explained'],
  // The byte count is deliberately not a round four-digit number: `idcheck.mjs` reads the staged
  // index for every identity string in `test-accounts.json`, and the first draft of this line
  // happened to spell the real PIN inside a synthetic fixture. A coincidence in a public repo is
  // still a leak, and the instrument caught it before the commit - which is what it is for.
  [line('D', 'mls_core::state', '[mls_core::state] save_state: 178432 bytes'), 'explained'],
  [line('D', 'mines_app_lib::commands::mls', '[mines_app_lib::commands::mls] recevoir_messages_batch'), 'explained'],
  [line('D', 'mines_app_lib::commands::push', '[mines_app_lib::commands::push] [CHANNEL_KEYS] ok'), 'explained'],
  [line('D', 'mines_app_lib::commands::storage', '[mines_app_lib::commands::storage] [RESUME] ok'), 'explained'],
  [line('I', 'mines_app_lib::mobile::background', '[mines_app_lib::mobile::background] [BG_SEND] ok'), 'explained'],
  [line('D', 'openmls::schedule', '[openmls::schedule] SenderDataSecret::derive_aead_key'), 'explained'],
  [line('D', 'openmls::tree::sender_ratchet', '[openmls::tree::sender_ratchet] secret_for_decryption'), 'explained'],
  [line('D', 'sqlx_core::logger', '[sqlx::query] summary="SELECT …"'), 'explained'],
  [line('D', 'hyper_util::client::legacy::pool', '[hyper_util::client::legacy::pool] pooling idle'), 'explained'],
  [line('D', 'tokio_tungstenite', '[tokio_tungstenite] websocket handshake'), 'explained'],
  [line('D', 'tungstenite::handshake::client', '[tungstenite::handshake::client] Client handshake done'), 'explained'],
  [line('D', 'tauri::manager', '[tauri::manager] Asset URI'), 'explained'],
  [line('D', 'jni::wrapper::java_vm::vm', '[jni::wrapper::java_vm::vm] Attached thread'), 'explained'],
  [line('V', 'Tauri/Plugin', 'Tauri plugin: sql'), 'explained'],

  // ── THE ORDERING CASE, and the reason this file exists ─────────────────────────────────────────
  // The application's own DEBUG line naming the condition it just handled. An observer that scanned
  // for `SecretReuse` before consulting the rules filed this as `severe`; three real sightings did
  // exactly that. The app decided, the observer honours the decision.
  // `notable`, not `explained`: the rule fires AND the line says `epoch`, so it is surfaced beside
  // the verdict without breaking `clean`. What this case pins is the thing that was wrong - that it
  // is not `severe`. It reaches a gating bucket only if the ordering regresses.
  [
    line('D', 'mls_core::messaging', '[mls_core::messaging] Benign same-epoch ratchet frame dropped: group=0000 reason=SecretReuseError'),
    'notable',
  ],
  // Rust's stdout capture relaying the WebView's startup chatter under one of our tags.
  [line('I', 'RustStdoutStderr', '[WARNING:android_webview/browser/network_service/net_helpers.cc:137] HTTP Cache size'), 'explained'],

  // ── ours, and NOT benign: the two markers this campaign exists to catch ────────────────────────
  [line('E', 'openmls::framing::private_message_in', '\tSecretReuseError'), 'severe'],
  [line('E', 'openmls::framing::private_message_in', '[openmls::framing::private_message_in]   Ciphertext generation out of bounds 280'), 'severe'],
  // An `E` on one of OUR tags is never explained away, even when its text looks routine: the level
  // is read before any rule is consulted, which is what stops a rule from becoming a silencer.
  [line('E', 'mines_app_lib::commands::mls', '[mines_app_lib::commands::mls] recevoir_messages_batch'), 'errors'],
  [line('F', 'CanariApp', 'anything at all'), 'severe'],

  // THE LINE THAT ANSWERS "was the notification decrypted". Logged at `W` by the app, which would
  // put it in `notable` and let a phase pass over a shade full of undecrypted notifications.
  [line('W', 'CanariFCM', 'Fallback notification: Nouveau message de <name>'), 'errors'],

  // ── ours, unnamed: the bucket that must not stay empty by accident ─────────────────────────────
  [line('D', 'CanariBoot', 'a line no rule has ever been written for'), 'unexplained'],
  // A warning we emitted is surfaced, not judged, and does not break `clean` on its own.
  [line('W', 'CanariFCM', 'an unnamed warning'), 'notable'],

  // ── NOT ours: counted, never able to break a verdict ───────────────────────────────────────────
  // The WebView's own Chrome-Sync subsystem - 39 lines of it in the first capture measured, all of
  // which the previous keyword filter reported as notable.
  [line('E', 'chromium', '[ERROR:components/sync/engine/get_updates_processor.cc:123] Sync error'), 'foreign'],
  // A DIFFERENT APPLICATION's WorkManager job. Judging `WM-WorkerWrapper` by tag alone put this in
  // Canari's record; ownership is read from the payload for the tags both owners share.
  [line('E', 'WM-WorkerWrapper', 'Could not create Worker com.linkedin.android.litrackingcomponent.Foo'), 'foreign'],
  // ART's garbage collector, on the app's own process name - our PROCESS, not our CODE.
  [line('I', 'fr.emse.canari', 'Background young concurrent mark compact GC freed 1100KB'), 'foreign'],
  // Platform tags shaped like a bare Rust crate name. `::` is the discriminator precisely so these
  // cannot be mistaken for ours.
  [line('D', 'audio_hw', 'out_standby'), 'foreign'],
  [line('I', 'usf_sensor_hal', 'sensor ready'), 'foreign'],
  [line('I', 'wpa_supplicant', 'CTRL-EVENT-SCAN-STARTED'), 'foreign'],
  // Our crash handler IS ours, when the payload names us.
  // One line, because logcat emits a stack trace as one line per frame and the classifier is handed
  // an array of them - a fixture carrying an embedded newline would test a string this parser is
  // never given.
  [line('E', 'AndroidRuntime', 'FATAL EXCEPTION: main - Process: fr.emse.canari'), 'severe'],

  // ── the instrument reporting on itself ─────────────────────────────────────────────────────────
  // An unreadable surface is not a clean one.
  ['LOGCAT UNAVAILABLE: no adb device attached', 'errors'],
];

/** Which gating bucket a one-line report put the fixture in. */
function bucketOf(fixture) {
  const r = logcatReport([fixture], 'selftest');
  for (const b of ['severe', 'errors', 'unexplained', 'notable']) if (r[b].length) return b;
  if (r.foreign.lines) return 'foreign';
  if (Object.keys(r.explainedBy).length) return 'explained';
  if (r.skipped.tauriConsole) return 'tauri-console';
  if (r.skipped.unparsed) return 'unparsed';
  return '(nothing at all)';
}

let failed = 0;
for (const [fixture, want] of CASES) {
  const got = bucketOf(fixture);
  if (got === want) continue;
  failed++;
  // The FIXTURE, not just the mismatch: a rule that moved needs its input beside the verdict, and
  // these lines are synthetic by construction so printing them leaks nothing.
  console.log(`  MISMATCH  want=${want.padEnd(12)} got=${got.padEnd(12)} ${fixture.slice(38, 150)}`);
}

/**
 * EVERY NAMED RULE MUST BE EXERCISED BY SOMETHING, or the list of rules and the list of cases drift
 * apart in the one direction nobody notices: a rule with no fixture is a rule that can rot for
 * months. Read from a single report over every fixture at once.
 */
const covered = new Set(Object.keys(logcatReport(CASES.map(([f]) => f), 'coverage').explainedBy));
const declared = logcatReport([], 'names').ruleNames ?? [];
const unexercised = declared.filter((n) => !covered.has(n));
if (unexercised.length) {
  failed++;
  console.log(`  ${unexercised.length} rule(s) with no fixture: ${unexercised.join(', ')}`);
}

console.log(
  failed
    ? `\nlogcat classifier: ${failed} problem(s) over ${CASES.length} cases`
    : `\nlogcat classifier: ${CASES.length} cases, every rule exercised, all correct`
);
process.exit(failed ? 1 : 0);
