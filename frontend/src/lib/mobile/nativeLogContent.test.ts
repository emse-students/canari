import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * NO NATIVE LOG LINE CARRIES WHAT A USER WROTE, WHO THEY ARE CALLED, OR A KEY.
 *
 * A release build logs: Android's `Log.*` reaches logcat whatever the build type (no shrinker rule
 * strips it), iOS `NSLog` lands in the unified log a sysdiagnose collects, and the Rust logger
 * writes to both and to a file. Those lines are read while debugging - which is why they exist -
 * and they are also read by anything that collects a device's logs. So they carry ids, counts,
 * states and reasons, and never the text of a message, a name, an emoji, a seed, a secret or a
 * token. The rule is in `docs/wiki/frontend/mobile.md` ("What a native log line may carry").
 *
 * Nothing types a value as "content", so no compiler sees a log line that prints one. This test
 * reads every native source the app ships and refuses any log call that INTERPOLATES an expression
 * which is not on an ALLOWLIST: a measure (`.length`, `!= null`, `isEmpty`), a flag, a count, an id,
 * a status, a class name (`e.javaClass.simpleName`), an outcome chosen between two literals, or a
 * value of a small NAMED set that a reader judged safe. Everything else fails, unless the call
 * carries `// log-safe: <why>` on its own lines, or its `file|expression` is in the reviewed table.
 *
 * It was a DENYLIST of content names, and a denylist is the wrong shape for a protective control: a
 * Kotlin lambda's `it` held a sender's real name and walked past it, and `e.message` of an
 * `org.json` exception, which quotes the WHOLE input, was never inspected at all. Now a new name
 * fails until a person has read where its value comes from.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC_TAURI = resolve(here, '../../../src-tauri');
const FRONTEND = resolve(here, '../../..');

type Lang = 'kotlin' | 'swift' | 'objc' | 'rust';

/** Every native source tree the shipped app compiles, by language. */
const TREES: { dir: string; lang: Lang; ext: string }[] = [
  {
    dir: join(SRC_TAURI, 'gen/android/app/src/main/java/fr/emse/canari'),
    lang: 'kotlin',
    ext: '.kt',
  },
  {
    dir: join(SRC_TAURI, 'plugins/tauri-plugin-customtabs/android/src/main'),
    lang: 'kotlin',
    ext: '.kt',
  },
  {
    dir: join(SRC_TAURI, 'plugins/tauri-plugin-gallery/android/src/main'),
    lang: 'kotlin',
    ext: '.kt',
  },
  {
    dir: join(SRC_TAURI, 'plugins/tauri-plugin-restore/android/src/main'),
    lang: 'kotlin',
    ext: '.kt',
  },
  {
    dir: join(SRC_TAURI, 'patches/tauri-plugin-keystore/android/src/main'),
    lang: 'kotlin',
    ext: '.kt',
  },
  { dir: join(SRC_TAURI, 'gen/apple/canari_NSE'), lang: 'swift', ext: '.swift' },
  { dir: join(SRC_TAURI, 'gen/apple/canari_Share'), lang: 'swift', ext: '.swift' },
  { dir: join(SRC_TAURI, 'gen/apple/Sources/canari'), lang: 'objc', ext: '.mm' },
  {
    dir: join(SRC_TAURI, 'patches/tauri-plugin-keystore/ios/Sources'),
    lang: 'swift',
    ext: '.swift',
  },
  {
    dir: join(SRC_TAURI, 'patches/tauri-plugin-system-components/ios/Sources'),
    lang: 'swift',
    ext: '.swift',
  },
  {
    dir: join(SRC_TAURI, 'plugins/tauri-plugin-customtabs/ios/Sources'),
    lang: 'swift',
    ext: '.swift',
  },
  {
    dir: join(SRC_TAURI, 'plugins/tauri-plugin-gallery/ios/Sources'),
    lang: 'swift',
    ext: '.swift',
  },
  { dir: join(SRC_TAURI, 'src'), lang: 'rust', ext: '.rs' },
  { dir: join(SRC_TAURI, 'plugins/tauri-plugin-customtabs/src'), lang: 'rust', ext: '.rs' },
  { dir: join(SRC_TAURI, 'plugins/tauri-plugin-gallery/src'), lang: 'rust', ext: '.rs' },
  { dir: join(SRC_TAURI, 'plugins/tauri-plugin-restore/src'), lang: 'rust', ext: '.rs' },
  { dir: join(FRONTEND, 'mls-core/src'), lang: 'rust', ext: '.rs' },
];

/** Tauri regenerates this directory; its one logger (`app.tauri.Logger`) is silent in release. */
const SKIPPED_DIRS = new Set(['generated']);

/**
 * THE ALLOWLIST. A value reaches a native log line only through one of the shapes below; anything
 * else fails. A denylist of "content names" is exactly what a leak walks past: `$it` held the
 * sender's real name and the `e.message` of org.json holds its whole input, and neither was on the
 * list. A chain is judged by its VALUE (its last segment that is not a {@link PASS_THROUGH} call):
 * `decrypted.callEnded` is `callEnded`, `seed["sessionId"]` is `sessionId`.
 *
 * Adding a name below is a review: the value must be one that CANNOT hold what a user wrote, who they
 * are, or a key. A one-off value goes through the annotation ({@link ANNOTATION}) instead, with its
 * reason on the line.
 */

/** Exact value names (case-sensitive), each a count, a size, a flag, a status, a position or a time. */
const SAFE_NUMBERS = new Set(
  `count size len length index idx epoch seq port errno status code ms total remaining dropped
  removed kept failures lost excess attempt attempts height width keyCode responseCode SDK_INT
  base_epoch msg_epoch group_epoch msgType at short true false null nil`.split(/\s+/)
);

/** Name shapes: a count or a time by suffix, a flag by prefix, a constant by spelling, an id. */
const SAFE_NAME_SHAPES: { shape: string; re: RegExp }[] = [
  { shape: 'a constant', re: /^[A-Z][A-Z0-9_]*$/ },
  {
    shape: 'a count, size, position or time',
    re: /(Count|Size|Epoch|Index|Ms|Millis|At|Seq|Bytes|_at|_count|_len|_ms)$/,
  },
  { shape: 'a flag', re: /^(is|has|was|can|should|did|will)([A-Z_]|_)/ },
  {
    shape: 'a party of a call or a conversation, by id',
    re: /^(subject|previous|next|holder|requester|recipient|stem|identity|joiner_name|f\.peer|peer)$/,
  },
  // Not every word ending in "id": `said`, `paid` and `android` are not ids.
  { shape: 'an id', re: /([a-z0-9](Id|Uuid)|(^|_)(id|gid|uid|uuid|pid|tid))$/ },
];

/** Flags and labels no call site fills with anything but a literal or an enum (reviewed). */
const SAFE_LABELS = new Set(
  `why what where reason label tag outcome mode kind verb state level source route verdict phase
  method action silent granted refused held superseded covers known mentionsMe unlabelled`.split(
    /\s+/
  )
);

/**
 * A Rust error value (`Err(e)`, `map_err(|e| ...)`) is reviewed safe AS A CATEGORY: every error type
 * this tree logs is an `std::io`, openmls, serde, SQLite, keystore or plugin error, or one of the
 * crate's own enums, and none quotes a message, a name or a key (an own error carries a static reason
 * or an id). Kotlin has no such category: an `org.json` message holds the WHOLE input, so a Kotlin
 * `e.message` or `$e` is annotated site by site.
 */
const RUST_ERROR_NAMES = new Set(['e', 'e2', 'err', 'error', 'db_e', 'err_str']);

/**
 * Locals and fields reviewed one by one on 2026-11-15: each is a count, a flag, a position, a pixel
 * measure, a duration, a protocol label (a push `type`, a MIME type, a host, a scheme, a settings or
 * file-name CONSTANT of the app's own) or a state enum, never a string a user typed. The same word
 * naming content in a NEW place is the case this list cannot see, which is why it is a list of
 * reviewed words rather than a pattern: a new word fails until it is read.
 */
const SAFE_LOCALS = new Set(
  `n a b c p y was on ok max now top left right light inset insets curve clamped change offset overlap
  minY maxY bodyPt bounds position rank present sent copy copied complete deleted written staged
  claimed released queued moved skipped fresh pruned seeded absent later behind before after back
  restore joined single batched unknown named unusable unreadable unopenable undecodable unproven
  stored offered missing output result terminal deferrable encrypted attempted damage had group_had
  app_had held_epoch minter envelope_sender trust scheme policy encoding class op via stage
  step how bypass seedSource http fields type mime host theme color value foreground cut generation
  claimed ended_generation moment mirrored seedsMirrored contextMirrored candidate sweep priority
  ringerMode audioMode speakerphone modeSetHere found notifications speaker described target
  showsMessage namesEachSender mentionsOnly leftToApp authorProven callHolds shape sample stamp
  targetPx timeoutSec orientationMode mode wire prefsName ime bands bandSpans selection other
  min_ep min_epoch group_ep msg_ep welcome_epoch existing_epoch live_epoch server_epoch
  message_index state_bytes expected_identity loaded_identity holds_state epoch_before epoch_after
  remove_proposals external unattended unattributed_kept unattributed_dropped left_to_the_app
  channels_dropped parked_files leftovers flags unrecorded winner first_index unreadable_lines
  waiting uncropped lockscreenVisibility importance appSounds vibrate sound done files held_channel
  hasVideo callEnded unlabelled domain locality bgStatus refusal fingerprint key_fingerprint current stated document dropped_ids declaredGroup serverSaysMentioned kind data_dir db_dir locale groupTag closedAs quiet`.split(
    /\s+/
  )
);

/**
 * Whole-expression shapes that are safe whatever they mention: a class name, an outcome chosen
 * between two literals, a comparison (prints true or false).
 */
const SAFE_EXPRESSIONS: RegExp[] = [
  /^[\w.?!]*\.(javaClass|class)\??\.simpleName$/,
  /^[\w.?!]*::class(\.java)?\.(simpleName|qualifiedName)$/,
  /^NSStringFromClass\(.*\)$/,
  /^\[\s*[\w.]+\s+class\s*\]$/,
  /^type\(of:\s*[\w.]+\)$/,
  // `if (c) "a" else "b"`, `if c { "a" } else { "b" }`, `c ? @"a" : @"b"` - strings stripped.
  /^if\s*\(.*\)\s*""\s*else\s*""$/,
  /^if\b.*\{\s*""\s*\}\s*else\s*\{\s*""\s*\}$/,
  /^.*\?\s*@?""\s*:\s*@?""$/,
  // A duration or a counter read off a Rust value.
  /\.(as_millis|as_secs|as_micros|as_u64|u32|sum|count|len)\(\)$/,
  // Helpers that return a fingerprint, a cache stem or a description built from ids and states.
  /^(\w*key_fingerprint|CanariDescribeDeepLink|avatar_cache_stem|copy_label|refused_of|id_of|describe)\(.*\)$/,
  // A conversation's log reference: `ch:` or `g:` and 8 characters of its id (`ConversationRef`),
  // or of a salon named by its bare id (`ConversationRef.ofSalon`).
  /^ConversationRef\.of(Salon)?\([\w.]+\)$/,
  // The helpers that say an error's domain and code, and a refusal's reason, instead of its text.
  /^(CanariErrorReason|errorReason|CanariPushContextRefusal)\(.*\)$/,
  // Where a throwable was thrown (its class and its frame), never what it says.
  /^throwableSite\([\w.?: ]+\)$/,
];

/** A comparison or a logical combination prints a boolean ({@link BRANCHES} permitting). */
const COMPARES = /(==|!=|<=|>=|&&|\|\|)/;

/**
 * A branch, a fallback or a closure: an expression holding one may print either side, so a
 * comparison or a measure INSIDE it says nothing of what it prints (`if (x != null) x else ""`,
 * `a ?: b`, `c ? a : b`, `unwrap_or_else(|| raw)`, `match`).
 */
const BRANCHES = /\bif\b|\belse\b|\bmatch\b|\?:|\?\?|\s\?\s|[(,]\s*(move\s*)?\|/;

/** The reviewed-safe marker, on the call's own lines: `// log-safe: <why the value holds no content>`. */
const ANNOTATION = /\/\/\s*log-safe:\s*(\S.{9,})/;

/** An expression that only MEASURES a value - it ENDS on the measure - says nothing of what it holds. */
const MEASURES =
  /(\.(length|size|count|len|isEmpty|isNotEmpty|isNullOrEmpty|isNullOrBlank|is_empty|is_some|is_none)(\(\))?|[!=]=\s*(null|nil))\s*$/;

/**
 * `bare` (strings already removed) with what its brackets hold emptied, and one wrapping pair of
 * parentheses dropped: what is left is what the expression does at its TOP level, so a comparison
 * in a call's argument or a lambda (`names.filter { it != me }`) is not taken for the value.
 */
function outermost(bare: string): string {
  let s = bare.trim();
  if (s.startsWith('(') && matching(s, 1, '(', ')') === s.length - 1) s = s.slice(1, -1);
  let out = '';
  let depth = 0;
  for (const c of s) {
    if (')]}'.includes(c)) depth--;
    if (depth === 0) out += c;
    if ('([{'.includes(c)) depth++;
  }
  return out;
}

/**
 * Calls that hand back (part of) the value they are called on: `body.take(60)` is still the body.
 * A chain's VALUE is its last segment that is not one of these - `decrypted.callEnded` is a flag,
 * `seed["sessionId"]` is an id.
 */
const PASS_THROUGH = new Set(
  [
    'take',
    'takeLast',
    'prefix',
    'suffix',
    'substring',
    'substringToIndex',
    'slice',
    'trim',
    'trimmed',
    'lowercase',
    'uppercase',
    'lowercased',
    'uppercased',
    'toString',
    'description',
    'orEmpty',
    'as_str',
    'display',
    'describe',
    'as_deref',
    'unwrap',
    'unwrap_or',
    'unwrap_or_default',
    'to_string',
    'to_owned',
    'clone',
    'chars',
    'collect',
    'get',
    'UTF8String',
  ].map((n) => n.toLowerCase())
);

/**
 * EXPRESSIONS REVIEWED ONE BY ONE on 2026-11-15, the allowlist's tail: an expression the shapes above
 * cannot name (a local called `name`, a path, an id spelled `call`) and a reader judged safe. Keyed
 * `file|expression` (the expression's first 100 characters, whitespace flattened), so the same word
 * naming content in ANOTHER file, or another expression, still fails; `Nx ` before a key says how many
 * lines it covers, so the next line spelling it in the same file fails too. Each group says WHY. A new line
 * that fits none of them is not added here by reflex: it is read, and either rewritten to a shape
 * above or annotated at the call with `// log-safe: <reason>`.
 */
const REVIEWED_GROUPS: [string, string[]][] = [
  [
    "a label, state or outcome the app spells itself (a constant, an enum, a classifier's output)",
    [
      // `OutboxRetry.Prospect` and its Rust token (`SendProspect::token`): an enum's name.
      'CanariFirebaseMessagingService.kt|batch.prospect',
      // `BackgroundJoinAnswer.Outcome.Failed`: the cause is a fixed token of Rust's
      // `BackgroundJoinError::cause`, the prospect an enum - each said at warn or error by level.
      '2x CanariFirebaseMessagingService.kt|joinAnswer.cause',
      '2x CanariFirebaseMessagingService.kt|joinAnswer.prospect',
      // `SweepFailureLedger.Outcome.Failed.cause`: a fixed word the worker spells at the failure.
      '2x MlsBackgroundWorker.kt|cause',
      'background.rs|prospect.token()',
      // `BackgroundJoinError::log`: the level is a `log::Level` chosen from the prospect, `site` is a
      // literal entry-point name, and `self` prints the typed cause token and the mls-core error
      // (a state, key or Welcome fault) - never message text, a name or a secret.
      'background.rs|self.log_level()',
      'background.rs|site',
      'background.rs|self',
      'admission.rs|previous.map_or("unclassified", AdmissionPolicy::as_str)',
      'owed_welcome.rs|match other { PendingSubmissionRead::None => "no record", PendingSubmissionRead::Unreadable => "unre',
      'CanariApplication.kt|installer ?: "(none - sideload)"',
      'CanariFirebaseMessagingService.kt|"[PUSH_WAKE] fetch FAILED queued=$queuedMessageId stage=${outcome.stage} silent=$silent mentionsOnly',
      '2x CanariFirebaseMessagingService.kt|base.scopeKind',
      'CanariFirebaseMessagingService.kt|missing.joinToString(",").ifEmpty { "none" }',
      'CanariFirebaseMessagingService.kt|outcome.detail',
      'CanariFirebaseMessagingService.kt|read.detail',
      'CanariFirebaseMessagingService.kt|settlement.token',
      'CanariFirebaseMessagingService.kt|shape.groupConversation',
      'CanariFirebaseMessagingService.kt|stop.token',
      // `BackgroundWelcomeAnswer.report`'s literal, its `Left.why` a literal or a server reason token.
      '3x CanariFirebaseMessagingService.kt|suffix',
      // `RingClosed`, an enum.
      'RingSequencer.kt|it',
      'canari_push.mm|ctx == nil ? ["push_context.json " stringByAppendingString:CanariPushContextRefusal()] : "another ac',
      // `finalCause` / `causeValue`, the extension's own fallback tokens.
      'NotificationService.swift|cause, privacy: .public',
      // A claim file's suffix: `claimed`, `draining`, spelled by `handoff.rs`'s callers.
      '3x handoff.rs|suffix',
      '2x MainActivity.kt|name',
      '4x MlsDeviceKeyStore.kt|alias',
      'KeyboardMediaBridge.mm|(__bridge void *)webView',
      'canari_ios.mm|[self.owners.allObjects componentsJoinedByString:","]',
      '2x canari_ios.mm|g_canariOrientationMode',
      '2x canari_ios.mm|name',
      'canari_ios.mm|taken ? "the page rides it" : [NSString stringWithFormat:"no ride (%@)", error ?: result]',
      '2x canari_push.mm|delegateClass',
      '2x canari_push.mm|kCanariRingtoneSound',
      'canari_push.mm|kMlsBinFileName',
      'canari_push.mm|kPushContextFileName',
      '2x NotificationService.swift|Self.pushContextRefusal(), privacy: .public',
      'NotificationService.swift|String(describing: declaredGroup), privacy: .public',
      '2x NotificationService.swift|String(describing: locality), privacy: .public',
      'NotificationService.swift|content.threadIdentifier.prefix(8), privacy: .public',
      'NotificationService.swift|key, privacy: .public',
      'SystemComponentsPlugin.swift|last',
      'SystemComponentsPlugin.swift|name, privacy: .public',
      'mls.rs|outcome.forgotten',
      'mls.rs|outcome.not_held',
      'mls_account_state.rs|left.join(", ")',
      'mls_account_state.rs|match &located { None => "absent from this install", Some(p) if p.starts_with(data_dir.join(PARKED_S',
      '3x push.rs|f.name',
      'push.rs|same_seed(held_seed, seed.seed_b64)',
      'storage.rs|crate::state::MLS_MANAGER_ABSENT',
      'storage.rs|installer',
      'happy_eyeballs.rs|addrs',
      '2x navigation.rs|logged',
      'push_text.rs|language',
      // A refusal memo's own line: epochs and a fixed phrase (`RefusalMemo`).
      'background.rs|said',
      'page_ring.rs|match &call_id { Some(c) => format!("rings call={c} in the page"), None => "rings no call in the pag',
    ],
  ],
  [
    "an id of a call, channel, user, device, group or session (never a name), or an address of the app's own backend",
    [
      'authorship.rs|proof.author',
      'authorship.rs|sender_identity',
      '3x device_trust.rs|added_by.unwrap_or("an unreadable sender")',
      'device_trust.rs|user',
      '2x group.rs|group_id_str',
      'members.rs|expected.unwrap_or("a well-formed device identity")',
      'messaging.rs|entrant.as_deref().unwrap_or("unreadable-identity")',
      '10x CallForegroundService.kt|call',
      '4x CanariFirebaseMessagingService.kt|channel',
      'CanariFirebaseMessagingService.kt|deepLink',
      'CanariFirebaseMessagingService.kt|eldest.key',
      'CanariFirebaseMessagingService.kt|requesterDev',
      'CanariFirebaseMessagingService.kt|requesterUser',
      'CanariFirebaseMessagingService.kt|url',
      'IncomingShare.kt|claimed.name',
      '2x IncomingShare.kt|dir.name',
      'IncomingShare.kt|staging.name',
      'IncomingShare.kt|uri.authority',
      'KeyboardMediaBridge.kt|uri',
      'GalleryPlugin.kt|uri',
      'push.rs|other_account',
      'concurrency.rs|claim.0',
      'background.rs|who',
      'proto_fields.rs|reel',
      // `ConversationShortcuts.ID_PREFIX` + `channel_`, the one caller's literal.
      'ConversationShortcuts.kt|prefix',
      'canari_push.mm|idLower.length > 8 ? [idLower substringToIndex:8] : idLower',
    ],
  ],
  [
    'the text of a native Rust error carried through JSON or a panic: the same category as a Rust `e` (see RUST_ERROR_NAMES)',
    [
      'fork_check.rs|f.detail',
      'messaging.rs|err_dbg',
      'state.rs|manager.state_composition_summary()',
      '2x CallRingPlayer.kt|message',
      // The native answer of the background join, cut to 60 chars: a closed token or, from a newer
      // build, another token - never message text.
      'CanariFirebaseMessagingService.kt|joinAnswer.raw?.take(60)',
      'CanariFirebaseMessagingService.kt|r.optString("error").take(80)',
      'canari_push.mm|r["error"]',
      'mls_account_state.rs|message',
      'lib.rs|info',
    ],
  ],
  [
    'a counter, a size, a position, a pixel measure or a duration',
    [
      '3x CallForegroundService.kt|wanted',
      '2x MlsBackgroundWorker.kt|streak',
      'CanariFirebaseMessagingService.kt|(now - absent.lastModified()) / 1_000',
      '2x CanariFirebaseMessagingService.kt|bounds.outHeight',
      '2x CanariFirebaseMessagingService.kt|bounds.outWidth',
      'CanariFirebaseMessagingService.kt|commitPayload.take(16)',
      'CanariFirebaseMessagingService.kt|file.exists()',
      'CanariFirebaseMessagingService.kt|iso.take(40)',
      '3x CanariFirebaseMessagingService.kt|ticket',
      '2x IncomingCallActivity.kt|sdk',
      'IncomingShare.kt|ceiling / 1024 / 1024',
      'IncomingShare.kt|waiting.optLong("epoch", 0)',
      'canari_ios.mm|(CACurrentMediaTime() - g_keyboardRiseAsked) * 1000.0',
      'canari_ios.mm|(unsigned long)webActivities',
      'canari_ios.mm|[UIApplication sharedApplication].preferredContentSizeCategory',
      'canari_ios.mm|app.idleTimerDisabled',
      '2x canari_ios.mm|content',
      'canari_ios.mm|insets.bottom',
      'canari_ios.mm|whats[i]',
      'canari_push.mm|(unsigned long)kCanariDrainMaxBatch',
      'NotificationService.swift|peak, privacy: .public',
      'NotificationService.swift|sessions, privacy: .public',
      'ShareCapture.swift|ShareRules.maxFiles',
      'ShareCapture.swift|ceiling / 1024 / 1024',
      'ButtonComponent.swift|holding, privacy: .public',
      'TabBarOverlay.swift|Double(self.tabBar.safeAreaInsets.bottom), format: .fixed(precision: 1)',
      'TabBarOverlay.swift|NSCoder.string(for: button.frame), privacy: .public',
      'TabBarOverlay.swift|NSCoder.string(for: self.tabBar.frame), privacy: .public',
      'GalleryPlugin.swift|status.rawValue, privacy: .public',
      'app_group_share.rs|manifest .get("files") .and_then(Value::as_array) .map_or(0, Vec::len)',
      '2x push.rs|done.gone()',
      'push.rs|f.bytes',
      '2x push_registration.rs|completed(done)',
      // A `'static` literal of the closed `SignOutCause` list, `unknown` for anything else.
      'push_registration.rs|sign_out_cause_label(&cause)',
    ],
  ],
  [
    'a sink that forwards a line some other call assembled: its callers are scanned, so the content is judged where it is built',
    [
      '2x CanariFirebaseMessagingService.kt|it',
      '8x NativePushLog.kt|msg',
      '2x NativePushLog.kt|tr',
    ],
  ],
  [
    "a path or a file name inside the app's own directories, generated by the app (never a name a user chose)",
    [
      'CanariFirebaseMessagingService.kt|key',
      '2x CanariFirebaseMessagingService.kt|name',
      'KeyboardMediaBridge.mm|name',
      'canari_ios.mm|CanariTauriDataDir()',
      'canari_push.mm|key',
      '3x app_group_share.rs|loggable_path(dir)',
      '6x app_group_share.rs|name',
      'at_rest_key.rs|dir.display()',
      '8x handoff.rs|name',
      'handoff.rs|rm',
      'handoff.rs|to.display()',
      '2x mls_account_state.rs|dir.file_name() .map(|n| n.to_string_lossy().into_owned()) .unwrap_or_default()',
      '2x mls_account_state.rs|name',
      '2x native_push_log.rs|name',
      'nse_outcomes.rs|key',
      '3x nse_outcomes.rs|name',
      'picked_files.rs|name',
      '3x push.rs|name',
      '2x storage.rs|base',
      'storage.rs|loggable_path(dir)',
      'storage.rs|file_name',
      '2x storage.rs|key',
      'storage.rs|name',
      'storage.rs|loggable_path(path)',
      '3x lib.rs|binary_name',
      'background.rs|name',
      '2x cross_version_push.rs|path.display()',
      'device_notice.rs|dir.display()',
      '7x device_notice.rs|key',
      'device_notice.rs|marker.display()',
      '2x device_notice.rs|path.display()',
      'graine.rs|name',
    ],
  ],
  [
    'the file name of a saved reel: its day and a short id, generated by `reelFileName` (saveReel.ts), never typed by a user',
    ['GalleryPlugin.kt|args.name', 'GalleryPlugin.kt|target.absolutePath'],
  ],
  [
    "the gallery plugin's staging: a session is a `crypto.randomUUID()` (`valid_session` refuses anything else), a staged path is the cache dir + prefix + session, and a saved name is `reelFileName` / `replayFileName` (never an attachment's name, which `share_staged` does not log)",
    ['10x commands.rs|session', '3x commands.rs|name', '2x commands.rs|path.display()'],
  ],
  [
    'a flag of the restore plugin (whether the key asks for cloud backup)',
    ['RestorePlugin.kt|cloudBackup'],
  ],
];
/**
 * Each reviewed key and HOW MANY lines it covers: `file|expr` is one line, `3x file|expr` three.
 * The count is what keeps a word as wide as `name` from being a pass for the next line in that
 * file that spells it - a new line is a new count, so it is read before the number moves.
 */
const REVIEWED = new Map(
  REVIEWED_GROUPS.flatMap(([, keys]) =>
    keys.map((k) => {
      const counted = /^(\d+)x (.*)$/s.exec(k);
      return counted ? ([counted[2], Number(counted[1])] as const) : ([k, 1] as const);
    })
  )
);

interface Finding {
  file: string;
  line: number;
  expr: string;
}

function walk(dir: string, ext: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIPPED_DIRS.has(name)) out.push(...walk(path, ext));
    } else if (name.endsWith(ext)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * The log calls of each language, up to and including the opening parenthesis: the platform
 * loggers, the standard streams (stdout and stderr reach logcat and the unified log too), and the
 * app's own WRAPPERS that take a finished line - Kotlin's `log(...)` sinks (`RingSequencer.Output`,
 * the recovery ladders' `log` lambda) and `NativePushLog`'s `sayOnce`. A wrapper whose line is
 * assembled away from any call is covered by {@link assembledLine}.
 *
 * KNOWN GAPS, which no regex over the source can close: a value laundered through a parameter whose
 * NAME is on the allowlist (`why`, `reason`, `detail` filled by a caller with a message), and a
 * wrapper with a new name. Both are review questions: the allowlist's labels say which names are
 * trusted to hold only literals, and a new wrapper is added to this pattern when it is written.
 */
const CALL_START: Record<Lang, RegExp> = {
  kotlin:
    /\bLog\.(v|d|i|w|e|wtf|println)\s*\(|(?<!fun )\b(?:System\.(?:out|err)\.)?print(?:ln)?\s*\(|(?<![\w.]|fun )(?:output\.)?log\s*\(|(?<!fun )\bsayOnce\s*\(|\b\w+\.printStackTrace\s*\(/g,
  swift:
    /\b(NSLog|os_log|print|debugPrint|dump)\s*\(|\b(?:logger|log)\.(debug|info|notice|error|fault|warning|log|trace|critical)\s*\(/g,
  objc: /\b(NSLog|os_log\w*|printf|fprintf)\s*\(/g,
  rust: /\b(?:log::)?(trace|debug|info|warn|error|log)!\s*\(|\b(println|eprintln|print|eprint|dbg)!\s*\(/g,
};

/**
 * Reads one call from just after its `(` to its matching `)`, and returns every expression whose
 * VALUE reaches the log line: the interpolations inside string literals (`$x`, `${...}`, `\(...)`,
 * Rust's `{x}`) and every argument that is not a string literal.
 */
function callExpressions(src: string, start: number, lang: Lang, span?: { end: number }): string[] {
  const exprs: string[] = [];
  let i = start;
  let depth = 1;
  let arg = '';
  const flushArg = () => {
    const a = arg.trim();
    // A bare literal (the format string, a tag spelled inline) is text the source wrote: its
    // interpolations were collected while it was read.
    if (/[A-Za-z_]/.test(withoutStrings(a))) exprs.push(a);
    arg = '';
  };
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '"' || (lang === 'objc' && c === '@' && src[i + 1] === '"')) {
      const quoteAt = c === '@' ? i + 1 : i;
      const triple = lang === 'kotlin' && src.startsWith('"""', quoteAt);
      const end = readString(src, quoteAt + (triple ? 3 : 1), lang, triple, exprs);
      // Kept in the argument: a quoted KEY (`seed["sessionId"]`) is what names the value.
      arg += src.slice(quoteAt, end);
      i = end;
      continue;
    }
    if (
      lang === 'rust' &&
      c === 'r' &&
      /r#*"/.test(src.slice(i, i + 4)) &&
      !/\w/.test(src[i - 1])
    ) {
      const hashes = /^r(#*)"/.exec(src.slice(i))![1];
      const close = '"' + hashes;
      const end = src.indexOf(close, i + 2 + hashes.length);
      const body = src.slice(i + 2 + hashes.length, end);
      for (const m of rustPlaceholders(body)) exprs.push(m);
      i = end + close.length;
      continue;
    }
    if (c === "'" && lang === 'rust') {
      // A Rust char literal (`'"'`, `'\n'`), never a lifetime (`'a` has no closing quote after one
      // character): read as a string opener, `'"'` swallowed the arguments after it.
      const char = /^'(\\.|[^\\'])'/.exec(src.slice(i));
      if (char) {
        arg += char[0];
        i += char[0].length;
        continue;
      }
    }
    if (c === "'" && lang !== 'rust') {
      // A character literal: skip it so a quote or a paren inside cannot unbalance the scan.
      const end = src.indexOf("'", i + (src[i + 1] === '\\' ? 3 : 2));
      i = end + 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (depth === 0) break;
    if (c === ',' && depth === 1) {
      flushArg();
    } else {
      arg += c;
    }
    i++;
  }
  flushArg();
  if (span) span.end = i;
  return exprs;
}

/** Skips a string literal starting at `i` (just past its opening quote), collecting interpolations. */
function readString(src: string, i: number, lang: Lang, triple: boolean, exprs: string[]): number {
  let literal = '';
  while (i < src.length) {
    const c = src[i];
    if (!triple && c === '\\') {
      if (lang === 'swift' && src[i + 1] === '(') {
        const end = matching(src, i + 2, '(', ')');
        exprs.push(src.slice(i + 2, end));
        i = end + 1;
        continue;
      }
      i += 2;
      continue;
    }
    if (triple ? src.startsWith('"""', i) : c === '"') {
      if (lang === 'rust') exprs.push(...rustPlaceholders(literal));
      return i + (triple ? 3 : 1);
    }
    if (lang === 'kotlin' && c === '$') {
      if (src[i + 1] === '{') {
        const end = matching(src, i + 2, '{', '}');
        exprs.push(src.slice(i + 2, end));
        i = end + 1;
        continue;
      }
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
      if (m) {
        exprs.push(m[1]);
        i += m[0].length;
        continue;
      }
    }
    literal += c;
    i++;
  }
  return i;
}

/**
 * The named placeholders of a Rust format string (`{text}`, `{text:?}`), read left to right as the
 * macro does: `{{` and `}}` are escaped braces, so `{{{text}}}` prints `{` + text + `}` and is read.
 */
export function rustPlaceholders(literal: string): string[] {
  const names: string[] = [];
  const unescaped = literal.replace(/\{\{|\}\}/g, '');
  for (const m of unescaped.matchAll(/\{([A-Za-z_][A-Za-z0-9_.]*)(:[^}]*)?\}/g)) names.push(m[1]);
  return names;
}

/** Index just past the `"` closing a string literal whose body starts at `i`, escapes honoured. */
function endOfString(s: string, i: number): number {
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '$' && s[i + 1] === '{') {
      // A Kotlin template: its braces may hold string literals of their own.
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === '"') i = endOfString(s, i + 1);
        else {
          if (s[i] === '{') depth++;
          if (s[i] === '}') depth--;
          i++;
        }
      }
      continue;
    }
    if (s[i] === '\\' && s[i + 1] === '(') {
      // A Swift interpolation: its parentheses may hold string literals of their own.
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === '"') i = endOfString(s, i + 1);
        else {
          if (s[i] === '(') depth++;
          if (s[i] === ')') depth--;
          i++;
        }
      }
      continue;
    }
    i += s[i] === '\\' ? 2 : 1;
  }
  return i + 1;
}

/** `s` with every string literal removed. */
function withoutStrings(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      i = endOfString(s, i + 1);
      out += '""';
    } else {
      out += s[i++];
    }
  }
  return out;
}

/** Index of the bracket closing the one opened just before `i`, skipping nested string literals. */
function matching(src: string, i: number, open: string, close: string): number {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      // An unclosed quote (a Rust `'"'` read as a string) ends the scan rather than restarting it
      // at 0, which looped forever.
      const close = src.indexOf('"', i + 1);
      if (close === -1) return src.length;
      i = close + 1;
      continue;
    }
    if (c === open) depth++;
    if (c === close && --depth === 0) return i;
    i++;
  }
  return i;
}

/**
 * The VALUE name of every chain an expression contains: for `a.b["c"].take(3)` that is
 * `c`, the last segment that is not a {@link PASS_THROUGH} call. Arguments of a call are chains of
 * their own, so `render(text)` still names `text`.
 */
function valueNamesIn(expr: string): string[] {
  const names: string[] = [];
  const chain = /[A-Za-z_][A-Za-z0-9_]*/y;
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"') {
      // A bare string literal is text the source wrote, not a value; a quoted KEY is handled below.
      i = endOfString(expr, i + 1);
      continue;
    }
    chain.lastIndex = i;
    const root = /[A-Za-z_]/.test(c) && !/[\w.]/.test(expr[i - 1] ?? '') ? chain.exec(expr) : null;
    if (!root) {
      i++;
      continue;
    }
    const segments = [root[0]];
    let j = chain.lastIndex;
    for (;;) {
      const rest = expr.slice(j);
      const field = /^\s*\??(?:\.|!!\.)\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
      const key = /^\s*\[\s*"([^"]*)"\s*\]/.exec(rest);
      const call = /^\s*\(/.exec(rest);
      if (field) {
        segments.push(field[1]);
        j += field[0].length;
      } else if (key) {
        segments.push(key[1]);
        j += key[0].length;
      } else if (call) {
        // The call's arguments are scanned as chains of their own; the chain itself continues. A
        // call whose one argument is a quoted key (`optString("text")`) reads THAT key.
        const close = matching(expr, j + call[0].length, '(', ')');
        const args = expr.slice(j + call[0].length, close);
        const quotedKey = /^\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*$/.exec(args);
        if (quotedKey) segments.push(quotedKey[1]);
        names.push(...valueNamesIn(args));
        j = close + 1;
      } else {
        break;
      }
    }
    // The ROOT is a value whatever it is called: a local named `suffix` or `description` is not a
    // call on anything, so it never passes through. A capitalised root with a tail is a type or an
    // object (`Answer.describe(outcome)`): what it returns is judged by its arguments, read above.
    const tail = segments
      .slice(1)
      .reverse()
      .find((s) => !PASS_THROUGH.has(s.toLowerCase()));
    const value =
      tail ?? (segments.length > 1 && /^[A-Z]/.test(segments[0]) ? undefined : segments[0]);
    if (value) names.push(value);
    i = j;
  }
  return names;
}

/** An Apple error's TEXT: it often quotes the file it failed on - a shared file's name, a path. */
const ERROR_TEXT = /\blocalized(Description|FailureReason|RecoverySuggestion)\b/;

/** Whether a value name is on the allowlist (the user-id rule needs the whole expression). */
function isSafeName(name: string, expr: string, lang?: Lang): boolean {
  if (lang === 'rust' && RUST_ERROR_NAMES.has(name)) return true;
  return (
    SAFE_NUMBERS.has(name) ||
    SAFE_LABELS.has(name) ||
    SAFE_LOCALS.has(name) ||
    SAFE_NAME_SHAPES.some((s) => s.re.test(name))
  );
}

/**
 * Whether an interpolated expression is NOT on the allowlist, i.e. may put content into the line.
 * `redacting` is true for a Swift `Logger` call ONLY: there an interpolation is private unless
 * marked public, so an error text is redacted in release. `NSLog`, Swift `print`, `os_log` with a
 * `%@` and every Rust and Kotlin logger write it whole - so there an error text is content, and
 * the line says the error's domain and code instead.
 */
export function leaksContent(expr: string, redacting = false, lang?: Lang): boolean {
  // A Swift `Logger` interpolation marked `.private` is redacted in release: nothing of it is written.
  if (redacting && /,\s*privacy:\s*\.private\s*$/.test(expr)) return false;
  if (ERROR_TEXT.test(expr)) return !redacting || /privacy:\s*\.public\b/.test(expr);
  // The privacy argument and a turbofish are syntax, not values.
  const value = expr
    .replace(/\((?:unsigned )?(?:long|int|NSUInteger|NSInteger)\)/g, '')
    .replace(/,\s*privacy:\s*\.\w+\s*$/, '')
    .replace(/::<[^>]*>/g, '')
    // An Objective-C selector part or a Swift argument label names a parameter, not a value - but
    // never the branch of a ternary written tight (`ok ? body:"none"`), which is a value.
    .replace(/(?<![:\w])(?<!\?\s*)[A-Za-z_]\w*:(?!:)/g, '')
    .trim();
  const branches = branchesOf(value);
  if (branches) return branches.some((b) => leaksContent(b, redacting, lang));
  const bare = withoutStrings(value);
  // A measure or a comparison prints a number or a boolean - but only when it is the WHOLE value:
  // `if (name != null) name else ""` and `body.take(body.length - 1)` hold one and print content.
  const top = outermost(bare);
  // A comparison is a boolean whatever its operands; a measure ENDING a concatenation is not the
  // value (`body + body.length` prints the body), so a `+` sends it to the names below.
  if (!BRANCHES.test(top) && (COMPARES.test(top) || (MEASURES.test(top) && !top.includes('+')))) {
    return false;
  }
  if (SAFE_EXPRESSIONS.some((re) => re.test(bare))) return false;
  return valueNamesIn(value).some((n) => !isSafeName(n, value, lang));
}

/** Whether the call `CALL_START` matched is a Swift `Logger` method (`logger.info(`, `log.error(`). */
function isRedactingCall(lang: Lang, call: string): boolean {
  return lang === 'swift' && /^(?:logger|log)\./.test(call);
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

/** Whether a call's own lines carry a `// log-safe: <reason>` annotation of a real reason. */
export function reviewedSafe(src: string, callStart: number, callEnd: number): boolean {
  const from = src.lastIndexOf('\n', callStart) + 1;
  const to = src.indexOf('\n', callEnd);
  // Strings removed: `"x $body // log-safe: ..."` is a line that PRINTS the words, not a review.
  return ANNOTATION.test(withoutStrings(src.slice(from, to === -1 ? src.length : to)));
}

/**
 * The expressions of the string a log call's LOCAL was assembled from: for `val line = "a=$x"` then
 * `Log.w(TAG, line)`, that is `x`. Only a local declared within the 40 lines above the call and
 * assigned a string literal (a template, or literals joined by `+`) is followed; anything else is
 * `undefined`, and the local is judged by its name like any other value.
 */
export function assembledLine(
  src: string,
  callAt: number,
  expr: string,
  lang: Lang
): string[] | undefined {
  if (!/^[A-Za-z_]\w*$/.test(expr)) return undefined;
  let windowStart = callAt;
  for (let n = 0; n < 40 && windowStart > 0; n++) {
    windowStart = src.lastIndexOf('\n', windowStart - 1);
  }
  windowStart = Math.max(0, windowStart);
  const window = src.slice(windowStart, callAt);
  const decl = new RegExp(
    `\\b(?:val|var|let)\\s+(?:mut\\s+)?${expr}\\s*(?::\\s*[\\w<>?&']+)?\\s*=\\s*(?=["@]|r#*")`,
    'g'
  );
  const found = [...window.matchAll(decl)].pop();
  if (!found) return undefined;
  // A `var` or a `let mut` may be reassigned or pushed to before the call: its first literal is not
  // what is printed, so it is judged by its name instead.
  if (/^(var|let\s+mut)\b/.test(found[0].trim())) return undefined;
  const rhsAt = windowStart + found.index! + found[0].length;
  // The right-hand side up to the end of its statement: its line, and the next while it ends on `+`
  // or the next line continues it (rustfmt and Swift break BEFORE the operator: `\n    + &text`).
  let end = src.indexOf('\n', rhsAt);
  while (
    end !== -1 &&
    (/\+\s*$/.test(src.slice(rhsAt, end)) || /^\s*(\+|\??\.)/.test(src.slice(end + 1)))
  ) {
    end = src.indexOf('\n', end + 1);
  }
  const rhs = src.slice(rhsAt, end === -1 ? src.length : end).replace(/;\s*$/, '');
  // Reviewed where it is assembled: the annotation rides the declaration's own lines.
  const declLine = src.slice(src.lastIndexOf('\n', rhsAt) + 1, end === -1 ? src.length : end);
  if (ANNOTATION.test(declLine)) return [];
  return callExpressions(`${rhs})`, 0, lang);
}

/** Whether `index` sits in a line comment or a block comment's `*` line (a KDoc naming `log(`). */
function inComment(src: string, index: number): boolean {
  const prefix = src.slice(src.lastIndexOf('\n', index - 1) + 1, index);
  return /^\s*(\*|\/\*)/.test(prefix) || withoutStrings(prefix).includes('//');
}

/**
 * The two values a top-level conditional may print - `c ? a : b`, `if (c) a else b`,
 * `if c { a } else { b }` - or `undefined` when the expression is not one. The condition prints
 * nothing, so only the branches are judged.
 */
export function branchesOf(expr: string): [string, string] | undefined {
  /** Top-level indices of `needle` in `s`, strings and brackets skipped. */
  const topLevel = (s: string, needle: RegExp): number[] => {
    const at: number[] = [];
    let depth = 0;
    for (let i = 0; i < s.length;) {
      const c = s[i];
      if (c === '"') {
        i = endOfString(s, i + 1);
        continue;
      }
      if ('([{'.includes(c)) depth++;
      if (')]}'.includes(c)) depth--;
      if (depth === 0) {
        needle.lastIndex = i;
        if (needle.test(s) && needle.lastIndex > i) at.push(i);
      }
      i++;
    }
    return at;
  };
  const e = expr.trim();
  const unbrace = (s: string) =>
    s
      .trim()
      .replace(/^\{([\s\S]*)\}$/, '$1')
      .trim();
  const ifAt = /^if\b\s*/.exec(e);
  if (ifAt) {
    const elseAt = topLevel(e, /\selse\s/y)[0];
    if (elseAt === undefined) return undefined;
    const head = e.slice(ifAt[0].length, elseAt);
    // Kotlin: `(cond) then`; Rust: `cond { then }`.
    const then = head.startsWith('(')
      ? head.slice(matching(head, 1, '(', ')') + 1)
      : head.slice(head.lastIndexOf('{'));
    return [unbrace(then), unbrace(e.slice(elseAt + ' else '.length))];
  }
  const q = topLevel(e, /\s\?\s/y)[0];
  if (q === undefined) return undefined;
  const rest = e.slice(q + 3);
  const colon = topLevel(rest, /\s:\s/y)[0];
  if (colon === undefined) return undefined;
  return [rest.slice(0, colon), rest.slice(colon + 3)];
}

/**
 * The throwable a call prints whole, if any: the receiver of `x.printStackTrace()`, or the third
 * argument of a Kotlin `Log.v/d/i/w/e/wtf` (`null` excepted). `argsAt..end` is the call's argument
 * text, as {@link callExpressions} read it.
 */
export function throwableArgument(
  lang: Lang,
  call: string,
  src: string,
  argsAt: number,
  end: number
): string | undefined {
  const printed = /^(\w+)\.printStackTrace/.exec(call);
  if (printed) return printed[1];
  if (lang !== 'kotlin' || !/^Log\.(v|d|i|w|e|wtf)\s*\($/.test(call)) return undefined;
  const args: string[] = [];
  let depth = 0;
  let arg = '';
  for (const c of withoutStrings(src.slice(argsAt, end))) {
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      args.push(arg.trim());
      arg = '';
    } else {
      arg += c;
    }
  }
  args.push(arg.trim());
  const third = args[2];
  return third && third !== 'null' ? third : undefined;
}

/** Every log call's unreviewed interpolations; `used` collects the reviewed keys that matched. */
function scan(used?: Map<string, number>): Finding[] {
  const findings: Finding[] = [];
  for (const tree of TREES) {
    for (const file of walk(tree.dir, tree.ext)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(CALL_START[tree.lang])) {
        if (inComment(src, m.index!)) continue;
        // The first argument of a Rust or ObjC call is the format string; Kotlin's first is the
        // tag. Every argument is checked: a variable handed in whole is as much the line as a
        // template is.
        const redacting = isRedactingCall(tree.lang, m[0]);
        const span = { end: 0 };
        const exprs = callExpressions(src, m.index! + m[0].length, tree.lang, span);
        if (reviewedSafe(src, m.index!, span.end)) continue;
        // A throwable handed to the logger is printed whole - its message, then its stack - whatever
        // the local is called (`catch (c: Exception)` is no safer than `e`), so it is judged by its
        // POSITION: `e.printStackTrace()`, or the third argument of a Kotlin `Log.*`.
        const thrown = throwableArgument(tree.lang, m[0], src, m.index! + m[0].length, span.end);
        if (thrown !== undefined) {
          // Judged here, by position, and not a second time by its name below.
          const at = exprs.lastIndexOf(thrown);
          if (at !== -1) exprs.splice(at, 1);
          const key = `${file.split(/[\\/]/).pop()}|${thrown}`;
          if (REVIEWED.has(key)) {
            used?.set(key, (used.get(key) ?? 0) + 1);
          } else {
            findings.push({
              file: relative(FRONTEND, file),
              line: lineOf(src, m.index!),
              expr: `${thrown} (a throwable, printed whole: log throwableSite(${thrown}) instead)`,
            });
          }
        }
        // A line handed in as a local is judged where it was ASSEMBLED.
        for (const [k, expr] of [...exprs.entries()].reverse()) {
          const assembled = assembledLine(src, m.index!, expr, tree.lang);
          if (assembled) exprs.splice(k, 1, ...assembled);
        }
        for (const expr of exprs) {
          const flat = expr.replace(/\s+/g, ' ');
          if (!leaksContent(expr, redacting, tree.lang)) continue;
          const key = `${file.split(/[\\/]/).pop()}|${flat.slice(0, 100)}`;
          if (REVIEWED.has(key)) {
            used?.set(key, (used.get(key) ?? 0) + 1);
          } else {
            findings.push({
              file: relative(FRONTEND, file),
              line: lineOf(src, m.index!),
              expr: expr.replace(/\s+/g, ' '),
            });
          }
        }
      }
    }
  }
  return findings;
}

describe('the scanner', () => {
  it('reads the interpolations of every language it guards', () => {
    expect(callExpressions('TAG, "a=$body b=${x.take(3)}")', 0, 'kotlin')).toEqual([
      'TAG',
      'body',
      'x.take(3)',
    ]);
    expect(callExpressions('"a=\\(text.prefix(8))")', 0, 'swift')).toEqual(['text.prefix(8)']);
    expect(callExpressions('@"a=%@", senderName)', 0, 'objc')).toEqual(['senderName']);
    expect(callExpressions('"a={text} b={}", seed_b64)', 0, 'rust')).toEqual(['text', 'seed_b64']);
  });

  it('refuses what is not on the allowlist, content or not', () => {
    // The two lines a denylist let through: Kotlin's `it` held a sender's name, and the message of
    // an `org.json` exception holds the whole input. Neither NAME is content-like, which is the point.
    expect(leaksContent('it')).toBe(true);
    expect(leaksContent('$it')).toBe(true);
    expect(leaksContent('e.message')).toBe(true);
    expect(leaksContent('lastException?.message')).toBe(true);
    expect(leaksContent('e')).toBe(true);
    expect(leaksContent('e', false, 'kotlin')).toBe(true);
    expect(leaksContent('parser.localizedDescription')).toBe(true);
    // A name that is not content-like is refused too: nothing vouches for it.
    expect(leaksContent('whatever')).toBe(true);
    expect(leaksContent('body.take(60)')).toBe(true);
    expect(leaksContent('data["senderName"]')).toBe(true);
    expect(leaksContent('json.optString("text")')).toBe(true);
    expect(leaksContent('renderMentions(text, myUserId).take(200)')).toBe(true);
    expect(leaksContent('msg.text')).toBe(true);
  });

  it('lets through the shapes that cannot hold content', () => {
    // A measure, a flag, a count.
    expect(leaksContent('text.length')).toBe(false);
    expect(leaksContent('name != null')).toBe(false);
    expect(leaksContent('queued.len()')).toBe(false);
    expect(leaksContent('hasVideo')).toBe(false);
    expect(leaksContent('started.elapsed().as_millis()')).toBe(false);
    // An id, truncated or not; a status; a code.
    expect(leaksContent('groupId.take(8)')).toBe(false);
    expect(leaksContent('group_id.chars().take(8).collect::<String>()')).toBe(false);
    expect(leaksContent('conn.responseCode')).toBe(false);
    expect(leaksContent('status, privacy: .public', true)).toBe(false);
    // A class name, never a message.
    expect(leaksContent('e.javaClass.simpleName')).toBe(false);
    expect(leaksContent('e.cause?.javaClass?.simpleName')).toBe(false);
    expect(leaksContent('NSStringFromClass([content class])')).toBe(false);
    // An outcome chosen between two literals, and a comparison.
    expect(leaksContent('if (token == previous) "unchanged" else "ROTATED"')).toBe(false);
    expect(leaksContent('self.usesClassicBar ? "yes" : "no", privacy: .public', true)).toBe(false);
    // A chain is judged by its VALUE: a flag of a decrypted object, an id of a seed.
    expect(leaksContent('decrypted.callEnded')).toBe(false);
    expect(leaksContent('seed["sessionId"].as_str().unwrap_or_default()')).toBe(false);
    // A Rust error value is the one reviewed category; Kotlin has none.
    expect(leaksContent('e', false, 'rust')).toBe(false);
    expect(leaksContent('e.message', false, 'rust')).toBe(true);
  });

  it('judges a measure or a comparison only when it is the whole value', () => {
    // A branch prints one of its sides: the comparison in its condition vouches for neither.
    expect(leaksContent('if (name != null) name else "none"')).toBe(true);
    expect(leaksContent('body.take(body.length - 1)')).toBe(true);
    expect(leaksContent('raw.unwrap_or_else(|| text.clone())', false, 'rust')).toBe(true);
    expect(leaksContent('text.length > 0 ? text : "none"')).toBe(true);
    expect(leaksContent('text.length > 0 ? "some" : "none"')).toBe(false);
    expect(leaksContent('if c { "a" } else { name }', false, 'rust')).toBe(true);
    expect(leaksContent('names.filter { it != me }.joinToString()')).toBe(true);
    expect(leaksContent('(a == b)')).toBe(false);
    // A local is a value whatever it is called, even the name of a call that passes a value through.
    expect(leaksContent('suffix')).toBe(true);
    expect(leaksContent('description')).toBe(true);
    // A type's call is judged by its arguments.
    expect(leaksContent('Answer.describe(outcome, baseEpoch)')).toBe(false);
    expect(leaksContent('Answer.describe(text)')).toBe(true);
    // A throwable is named by where it was thrown, never by what it says.
    expect(leaksContent('throwableSite(e)')).toBe(false);
    expect(leaksContent('throwableSite(e.cause ?: e)')).toBe(false);
  });

  it('reads a line where it was assembled, and the wrappers that take one', () => {
    const src = 'val line = "a=$text b=${n}"\nif (x) Log.w(TAG, line)';
    expect(assembledLine(src, src.indexOf('Log.w'), 'line', 'kotlin')).toEqual(['text', 'n']);
    const reviewed =
      'val why = "m: ${e.message}" // log-safe: a system call handed no input\nLog.w(TAG, why)';
    expect(assembledLine(reviewed, reviewed.indexOf('Log.w'), 'why', 'kotlin')).toEqual([]);
    expect(assembledLine(src, src.indexOf('Log.w'), 'other', 'kotlin')).toBeUndefined();
    const kotlinCalls = (s: string) => [...s.matchAll(CALL_START.kotlin)].map((m) => m[0]);
    expect(kotlinCalls('output.log(true, "x") log("y") e.printStackTrace() println(z)')).toEqual([
      'output.log(',
      'log(',
      'e.printStackTrace(',
      'println(',
    ]);
    expect(kotlinCalls('fun log(message: String) fun println(p: Int) Math.log(2.0)')).toEqual([]);
    expect([...'log::log!(level, "x")'.matchAll(CALL_START.rust)].length).toBe(1);
  });

  it('reads the shapes a second review found walking past it (2026-11-15)', () => {
    // A measure ending a concatenation is not the value.
    expect(leaksContent('body + body.length')).toBe(true);
    expect(leaksContent('a.size + b.size')).toBe(false);
    // A ternary branch written tight is a value, not a Swift label or a selector part.
    expect(leaksContent('ok ? body:"none"')).toBe(true);
    // Rust's escaped braces around a placeholder still print it.
    expect(rustPlaceholders('{{{text}}} {{literal}} {n:?}')).toEqual(['text', 'n']);
    // A Rust char literal is not a string opener: the arguments after it are still read, and the
    // scan ends (an unclosed quote looped forever).
    expect(callExpressions(`"{}: {}", s.trim_matches('"'), text)`, 0, 'rust')).toEqual([
      `s.trim_matches('"')`,
      'text',
    ]);
    // A `var` may be reassigned before the call, and a statement may continue on the next line.
    const reassigned = 'var line = "start"\nline = "x $body"\nLog.w(TAG, line)';
    expect(assembledLine(reassigned, reassigned.indexOf('Log.w'), 'line', 'kotlin')).toBe(
      undefined
    );
    const continued = 'let line = "x ".to_string()\n    + &text;\nlog::warn!("{line}");';
    expect(assembledLine(continued, continued.indexOf('log::'), 'line', 'rust')).toEqual([
      '"x ".to_string()\n    + &text',
    ]);
    // A throwable is printed whole whatever it is called.
    const log = 'Log.e(TAG, "x: ${c.javaClass.simpleName}", c)';
    expect(throwableArgument('kotlin', 'Log.e(', log, 6, log.length - 1)).toBe('c');
    expect(throwableArgument('kotlin', 'Log.e(', 'Log.e(TAG, "x", null)', 6, 20)).toBe(undefined);
    expect(throwableArgument('kotlin', 'c.printStackTrace(', '', 0, 0)).toBe('c');
    // Not every word ending in "id" is an id.
    expect(leaksContent('said')).toBe(true);
    expect(leaksContent('groupId')).toBe(false);
    expect(leaksContent('group_id')).toBe(false);
  });

  it('honours a `// log-safe:` annotation of a real reason, and nothing weaker', () => {
    const call = 'Log.w(TAG, "x: ${e.message}")';
    expect(
      reviewedSafe(
        `${call} // log-safe: message of a system call; no user input here`,
        0,
        call.length
      )
    ).toBe(true);
    expect(reviewedSafe(`${call} // log-safe: ok`, 0, call.length)).toBe(false);
    // The words inside the logged string print; they review nothing.
    const printed = 'Log.w(TAG, "x $body // log-safe: trust me on this one")';
    expect(reviewedSafe(printed, 0, printed.length)).toBe(false);
    expect(reviewedSafe(`${call} // fine`, 0, call.length)).toBe(false);
    expect(
      reviewedSafe(`${call}\n// log-safe: on the next line is not on the call`, 0, call.length)
    ).toBe(false);
  });

  it('refuses an Apple error text where nothing redacts it, and says domain and code instead', () => {
    expect(leaksContent('error.localizedDescription')).toBe(true);
    expect(leaksContent('[error localizedDescription]')).toBe(true);
    expect(leaksContent('err.localizedFailureReason')).toBe(true);
    // In a Swift Logger call it is private unless marked public.
    expect(leaksContent('error.localizedDescription', true)).toBe(false);
    expect(leaksContent('error.localizedDescription, privacy: .public', true)).toBe(true);
    expect(leaksContent('error.localizedDescriptionX, privacy: .publicX', true)).toBe(true);
    // An interpolation marked `.private` is redacted in release whatever it holds.
    expect(leaksContent('args.name, privacy: .private', true)).toBe(false);
    expect(leaksContent('args.name, privacy: .public', true)).toBe(true);
    // The error's domain and code are what an unredacted line says instead.
    expect(leaksContent('failure.domain')).toBe(false);
    expect(leaksContent('(long)failure.code')).toBe(false);
    expect(leaksContent('CanariErrorReason(error)')).toBe(false);
    // The whole NSError handed to `%@` writes its userInfo, so it is refused.
    expect(leaksContent('error')).toBe(true);
  });

  it('exempts a Swift Logger call alone from naming an error text', () => {
    expect(isRedactingCall('swift', 'log.warning(')).toBe(true);
    expect(isRedactingCall('swift', 'logger.error(')).toBe(true);
    expect(isRedactingCall('swift', 'NSLog(')).toBe(false);
    expect(isRedactingCall('swift', 'print(')).toBe(false);
    expect(isRedactingCall('objc', 'NSLog(')).toBe(false);
    expect(isRedactingCall('rust', 'log::error!(')).toBe(false);
  });

  it('finds the native sources it is meant to read', () => {
    for (const tree of TREES) expect(walk(tree.dir, tree.ext).length).toBeGreaterThan(0);
  });
});

/**
 * THE SCAN RUNS ONCE, AT COLLECTION, which no test deadline covers. It walks and reads every native
 * source from disk; inside a test, twice, that walk was charged to the 5 s timeout, and on a loaded
 * machine it outlasted it (docs/wiki/test-suite-reform.md, the sixth load reading).
 */
const usedReviews = new Map<string, number>();
const nativeFindings = scan(usedReviews);

describe('native log lines in every build', () => {
  it('carry no message text, name, emoji, seed, secret or token', () => {
    const findings = nativeFindings;
    expect(
      findings.map((f) => `${f.file}:${f.line} interpolates \`${f.expr.slice(0, 140)}\``)
    ).toEqual([]);
  });

  it('covers exactly the lines each reviewed expression was read on', () => {
    // A stale entry, or a count above what is there, is a free pass waiting for the next line that
    // happens to spell it; a count below means a line nobody read rides an old review.
    const used = usedReviews;
    expect(
      [...REVIEWED.entries()]
        .filter(([k, n]) => (used.get(k) ?? 0) !== n)
        .map(([k, n]) => `${k}: reviewed ${n}, found ${used.get(k) ?? 0}`)
    ).toEqual([]);
  });
});

describe('the notification extension on a store build', () => {
  const NSE = join(SRC_TAURI, 'gen/apple/canari_NSE/NotificationService.swift');

  it('logs through its Logger, never a Swift NSLog, which arrives as <private> whole', () => {
    // `1.6.5-alpha.1` on the iPhone 12: the generic banner of a killed-app DM came with every
    // extension line `<private>`, so its reason could not be read. The scan above still holds every
    // interpolation of the Logger calls to ids, counts, states and reasons.
    const src = readFileSync(NSE, 'utf8');
    expect(src).not.toMatch(/\bNSLog\s*\(/);
    expect(src).toContain('Logger(subsystem: "fr.emse.canari", category: "nse")');
    expect(src).toMatch(/NseLog\.log\.notice\(\s*"\[CanariNSE\] outcome=/);
  });

  it('names the privacy of every value it interpolates', () => {
    // A string interpolated with no privacy argument is redacted on a store build, silently: the
    // choice is written value by value, `.public` for an id, a count, a state or a reason (the scan
    // above refuses one that is content), `.private` for anything else.
    const src = readFileSync(NSE, 'utf8');
    const unmarked: string[] = [];
    for (const m of src.matchAll(/NseLog\.log\.\w+\(/g)) {
      for (const expr of callExpressions(src, m.index! + m[0].length, 'swift')) {
        if (!/privacy:\s*\.(public|private)\s*$/.test(expr)) {
          unmarked.push(`${lineOf(src, m.index!)}: ${expr}`);
        }
      }
    }
    expect(unmarked).toEqual([]);
  });
});

/**
 * EVERY SWIFT FILE THE APP COMPILES, DERIVED FROM THE TREE RATHER THAN LISTED: the extension, the
 * share extension, the patched plugins and Canari's own. A Swift `NSLog` is `<private>` WHOLE on a
 * store build, literal text included (the tab-bar plugin's line, `1.6.4-alpha.4`; the extension's,
 * `1.6.5-alpha.1`), so a line meant to be read goes through a `Logger` - whose interpolations
 * the content scan above still holds to ids, counts, states and reasons.
 */
describe('every Swift line on a store build', () => {
  const ROOTS = ['gen/apple', 'patches', 'plugins'].map((d) => join(SRC_TAURI, d));
  /** Build outputs and dependency checkouts are not sources this repository writes. */
  const NOT_SOURCES = new Set(['generated', '.build', 'build', 'node_modules', 'Pods']);
  const swiftFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return NOT_SOURCES.has(name) ? [] : swiftFiles(path);
      return name.endsWith('.swift') ? [path] : [];
    });
  const files = ROOTS.flatMap(swiftFiles);

  it('finds the Swift sources it guards', () => {
    const names = files.map((f) => relative(SRC_TAURI, f).replaceAll('\\', '/'));
    for (const known of [
      'gen/apple/canari_NSE/NotificationService.swift',
      'patches/tauri-plugin-keystore/ios/Sources/KeystorePlugin.swift',
      'patches/tauri-plugin-system-components/ios/Sources/TabBarOverlay.swift',
      'plugins/tauri-plugin-customtabs/ios/Sources/CustomTabsPlugin.swift',
      'plugins/tauri-plugin-gallery/ios/Sources/GalleryPlugin.swift',
    ]) {
      expect(names).toContain(known);
    }
  });

  it('never goes through a Swift NSLog, which arrives as <private> whole', () => {
    const offenders = files.flatMap((file) => {
      const src = readFileSync(file, 'utf8');
      return [...src.matchAll(/\bNSLog\s*\(/g)].map(
        (m) => `${relative(SRC_TAURI, file)}:${lineOf(src, m.index!)}`
      );
    });
    expect(offenders).toEqual([]);
  });
});
