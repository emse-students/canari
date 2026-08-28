# Android / iOS parity audit

**Read from the sources on 2026-08-28, on the user's ask, with NO device in hand.** Every claim below
cites the file that carries it. What this audit CANNOT do is say which of the graphical findings
produces which artefact on a real iPhone - that needs the hardware, and saying otherwise would repeat
the mistake this area has already made three times.

**Fixed, same day, by code (still needs the hardware proof this page has never had): 1.1, 1.2, 1.3,
1.4, 2.1, 2.2, 2.3, 2.6.** Story in `CHANGELOG.md`. **1.5 and 2.5 are deliberately NOT fixed here**
(1.5 wants one `app.css` pass with a device in hand, already tracked as its own item; 2.5 is
platform-inherent, nothing to converge). **2.4 has no possible fix** - confirmed by reading the code,
not just asserted - iOS offers no boot-wake hook at all. Each section below is marked in place; the
original finding is kept verbatim underneath so the reasoning is not lost.

**Why it exists.** Three of three iOS defects found so far were invisible to every gate in this repo
(the CORS allowlist, the third-party refresh cookie, the FCM ordering). Each was found from USE, one
at a time, after shipping. `gen/android` and `gen/apple` are two generated projects that nothing
compares against each other, so an asymmetry is only ever noticed by the person holding the phone.
This page is that comparison, done once, deliberately, so the next finding is read off a list rather
than off a symptom.

**Its companion is [mobile.md](mobile.md)**, which explains how each platform works; this page only
says where they DISAGREE. The two open UI items are the P2 in [backlog](../backlog.md), and the
conclusion they share - one pass over `app.css` with a device in hand, not seven local patches - is
reinforced by everything in section 1 here.

---

## 1 - Graphical

### 1.1 The two platforms took OPPOSITE decisions about the system bars - FIXED 2026-08-28

**By the user's decision: iOS now matches Android rather than the reverse.** `UIStatusBarHidden` is
`false` in [`Info.plist`](../../../frontend/src-tauri/gen/apple/canari_iOS/Info.plist), so both
platforms go edge-to-edge but keep the bar, reading its inset via `env(safe-area-inset-top)`. **Still
owed: the hardware measurement this page never had** - whether the visual result actually matches
Android's now that both declare the same intent.

Original finding, kept for the reasoning: Android goes edge-to-edge on purpose and keeps the bars,
reading their insets: `enableEdgeToEdge()` in
[`MainActivity.kt`](../../../frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/MainActivity.kt),
with a comment naming the Xiaomi/HyperOS device where the insets read back as zero without it. iOS
used to hide the status bar outright, and neither declaration cited the other.

### 1.2 `UIStatusBarStyle` is declared as an empty string - FIXED 2026-08-28

[`Info.plist`](../../../frontend/src-tauri/gen/apple/canari_iOS/Info.plist) now sets
`UIStatusBarStyle` to `UIStatusBarStyleDefault` (auto-switches dark/light content with the system
appearance since iOS 13) and declares `UIViewControllerBasedStatusBarAppearance` as `false`, so the
plist value is what actually governs - Tauri/wry installs no view controller that overrides
`preferredStatusBarStyle`, so without that key this would still be a dead declaration.

### 1.3 The launch background is the product's colour on Android and Apple's on iOS - FIXED 2026-08-28

iOS now paints an `AppBackground` colour set in `Assets.xcassets` - `#FFF9FBFF` light / `#FF070B12`
dark, the exact values Android's `app_background` uses - referenced from
[`LaunchScreen.storyboard`](../../../frontend/src-tauri/gen/apple/LaunchScreen.storyboard) instead of
Apple's `systemBackgroundColor`, which was hardcoded to white with no dark variant at all despite its
name.

### 1.4 The WKWebView's background is never set - FIXED 2026-08-28

There is still no iOS peer of `onWebViewCreate` - wry creates the WKWebView inside `ffi::start_app()`,
after `canari_ios_bootstrap()` returns - so the fix is applied lazily on the first `didBecomeActive`,
the same hook the keyboard media bridge already uses to find the WebView after the fact
(`CanariApplyWebViewTransparency` in
[`canari_ios.mm`](../../../frontend/src-tauri/gen/apple/Sources/canari/canari_ios.mm)): `opaque = NO`,
`backgroundColor` and `scrollView.backgroundColor` both `clearColor`. **Still owed: the hardware
measurement** - whether `didBecomeActive` is early enough relative to hydration to actually remove
the flash, the way `onWebViewCreate` (called at creation) does on Android.

### 1.5 The safe area has no owner

`safe-area-inset-top` appears 17 times across 12 files; `-bottom` 35 times. The top IS handled - the
gap is not absence but the lack of a single contract, where the bottom has one and the keyboard has
one. Any fix applied per-component will drift, which is the argument the emoji, dead-row and
device-row items each reached independently.

### 1.6 One asymmetry that CLOSED itself, by a different mechanism - do not "re-fix" it

Android withdraws the navigation-bar inset while the keyboard is up (`applyKeyboardInsets`), because
the bar is then behind the keyboard and the reserved strip becomes an empty band.

iOS gets the same outcome for free since 2026-08-28: a WebView whose bottom edge no longer reaches
the home indicator is given `safeAreaInsets.bottom == 0` by UIKit, so `env(safe-area-inset-bottom)`
stops reserving it. **Same result, different mechanism, and neither is redundant.** Adding an explicit
iOS inset override would double-count.

---

## 2 - Software

### 2.1 Keyboard media is an EVENT on Android and a POLL on iOS - FIXED 2026-08-28

iOS no longer polls. It observes `UIPasteboardChangedNotification`
([`KeyboardMediaBridge.mm`](../../../frontend/src-tauri/gen/apple/Sources/canari/KeyboardMediaBridge.mm)) -
the real event a third-party keyboard's pasteboard write already produces, since a third-party iOS
keyboard has no direct content-commit API into a host app the way Android's IME does and mediates
through the pasteboard instead. This closes BOTH problems the original finding named: no clock
remains, and the notification is edge-triggered, so the "already-there vs just-committed" changeCount
bookkeeping the poll needed to reject stale pasteboard content is gone too - not papered over, just no
longer necessary.

Original finding, kept for the reasoning: Android hooks the real pipeline -
`setOnReceiveContentListener` plus `InputConnectionCompat.createWrapper` - so a Gboard GIF commit is
delivered as it happens
([`KeyboardMediaBridge.kt`](../../../frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/KeyboardMediaBridge.kt)).
iOS used to poll `UIPasteboard.general.changeCount` every 0.5 s on an `NSTimer`.

### 2.2 Two six-second waits in the iOS push path - ANSWERED, not removed, 2026-08-28

Both waits are sound: each sits on top of an `NSURLSession` request that already carries its own 5 s
`timeoutInterval`, so the 6 s ceiling is a 1 s safety margin above the timeout that actually bounds a
slow network, not a substitute for one. What the audit asked - "ask of each what it would mean if it
fired" - is now answered rather than left silent: firing means the completion handler itself never
ran (a genuinely stuck data task, not an ordinary timeout, which the request's own `timeoutInterval`
already resolves), and that case is now logged distinctly in
[`canari_push.mm`](../../../frontend/src-tauri/gen/apple/Sources/canari/canari_push.mm) instead of
returning `nil` indistinguishably from an ordinary empty server response.

### 2.3 The MLS state lock does not cross processes on iOS - ANSWERED 2026-08-28

**The assertion was checked, not just restated, and holds.** `NotificationService.swift`'s file-level
comment ("the extension never writes mls.bin") is true - grepping the NSE for any write to
`mlsBinFile` finds none - and the app's own write,
`CanariMirrorPushStateToAppGroup`, already uses `NSDataWritingAtomic` (temp file + rename), so a
concurrent NSE read can never observe a torn file. The proof now lives next to `g_mlsStateLock`'s
declaration in
[`canari_push.mm`](../../../frontend/src-tauri/gen/apple/Sources/canari/canari_push.mm), with a
cross-reference from `NotificationService.swift`, so the next reader does not have to re-derive it.
If either half of the proof ever stops holding, the fix belongs at THAT half, not at the lock.

Original finding, kept for the reasoning:
[`MlsStateLock.kt`](../../../frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/MlsStateLock.kt)
is a `ReentrantLock`, sound on Android because the FCM service and WorkManager run in the same
process. On iOS the NSE is a separate process and `g_mlsStateLock` is an `NSLock`, which cannot
coordinate with it - the question was always whether that mattered, not whether the lock types
differed.

### 2.4 Nothing re-registers iOS after a reboot or an app update - CONFIRMED, NOT FIXABLE, 2026-08-28

**No code change: iOS genuinely offers no boot-wake hook**, and the gap was already correctly
documented in two places before this pass -
[`CanariBootReceiver.kt`](../../../frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariBootReceiver.kt)'s
own comment naming the absence, and the `BGTaskSchedulerPermittedIdentifiers` comment in
[`Info.plist`](../../../frontend/src-tauri/gen/apple/canari_iOS/Info.plist) ("iOS never wakes a
force-quit app"). Recorded here as CONFIRMED rather than left ambiguous: this is a platform ceiling,
not an unfixed defect.

Android has `CanariBootReceiver.kt` on `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`: it re-registers the
push token and drains the outbox with no user action. iOS waits for the user to open the app. Worth
knowing before reading a "missing push" report as a defect.

### 2.5 Four notification channels against one category

Android creates `MESSAGES`, `SOCIAL`, `FORMS` and `CALLS`
([`CanariApplication.kt`](../../../frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariApplication.kt)),
each independently tunable by the user in system settings. iOS has one category carrying the quick
actions, and the user's control is all-or-nothing.

Platform-inherent, and listed anyway because it is a PRODUCT difference rather than a plumbing one:
"silence the social notifications but keep the messages" exists on one platform only.

### 2.6 French in developer-facing logs - FIXED 2026-08-28

All seven French `NSLog` lines in
[`canari_push.mm`](../../../frontend/src-tauri/gen/apple/Sources/canari/canari_push.mm) are now
English. **The original count undercounted its own finding**: it named two lines
(`BGTask outboxRetry planifie`, `handler enregistre`), but a full grep of the file for the same
pattern found five more - a second `enregistre` line and three `MlsStateLock occupe` lock-contention
lines - all fixed in the same pass, since the repo's English-only rule for dev-facing strings is not
scoped to what one audit happened to sample.

---

## 3 - Already at parity: do not chase these

Verified in both trees while writing this page, so nobody spends an evening re-deriving them.

|Concern|Android|iOS|
|---|---|---|
|Orientation|phone portrait / tablet free, via a resource qualifier|`UISupportedInterfaceOrientations` (+ `~ipad`)|
|Quick actions|`RemoteInput` reply, mark-read, call-decline|`UNTextInputNotificationAction`, mark-read, `CXEndCallAction`|
|Incoming-call ring|`CallStyle` + full-screen intent|CallKit `CXProvider` + PushKit|
|Per-conversation stacking|channels and groups|`threadIdentifier`|
|Background drain|`MlsBackgroundWorker` + `OutboxRetryWorker`|BGTasks `cleanup` + `outboxRetry`, both registered AND submitted|
|App-chosen language in notifications|`appLocaleContext` from `push_context.json`|the NSE reads the same `locale` field|
|Deep links|intent-filters + `autoVerify`|`CFBundleURLTypes` + AASA|
|Device key at rest|Android Keystore|Keychain, `AfterFirstUnlockThisDeviceOnly`, App Group|

**And one asymmetry closed BY CONSTRUCTION, which must not be given a peer**: Android flushes the
WebView cookie jar (`flushAndroidCookies`, `CookieManager.flush()` on pause and stop) for a documented
replay defect. iOS has no refresh cookie at all since it carries the credential in `X-Canari-Refresh`
([sessions](../sessions.md#the-credential-a-client-carries-itself)). There is nothing to flush.

---

## 4 - What this page does NOT establish

**Which finding causes what the user sees.** Sections 1.1, 1.3 and 1.4 are the structural candidates
for the reported bars and bands; ranking them is a device measurement, not an argument. Everything
native in this repo is verified by COMPILING, which proves nothing about running - the rule that has
now cost this platform three defects in a row.

**That the list is complete.** It compares what the two projects CONTAIN. A mechanism absent from
BOTH is invisible to it, and so is anything the web layer does that only one engine honours - the
`interactive-widget=resizes-content` hint in `app.html`, for instance, is honoured by Chromium and
ignored by WKWebView, which is precisely why the keyboard needed a native answer on iOS.
