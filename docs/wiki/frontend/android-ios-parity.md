# Android / iOS parity audit

**Read from the sources on 2026-08-28, on the user's ask, with NO device in hand.** Every claim below
cites the file that carries it. What this audit CANNOT do is say which of the graphical findings
produces which artefact on a real iPhone - that needs the hardware, and saying otherwise would repeat
the mistake this area has already made three times.

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

### 1.1 The two platforms took OPPOSITE decisions about the system bars

Android goes edge-to-edge on purpose and keeps the bars, reading their insets: `enableEdgeToEdge()`
in [`MainActivity.kt`](../../../frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/MainActivity.kt),
with a comment naming the Xiaomi/HyperOS device where the insets read back as zero without it.

iOS hides the status bar outright: `UIStatusBarHidden` is `true` in
[`Info.plist`](../../../frontend/src-tauri/gen/apple/canari_iOS/Info.plist).

Neither declaration cites the other, and nothing in the repo records a decision to diverge. **This is
the first candidate for the bars the user reports**, and the cheapest thing to settle on device: the
question is whether `env(safe-area-inset-top)` still reserves the sensor housing once the status bar
is hidden, which is a one-screenshot measurement and not a thing to reason about from here.

### 1.2 `UIStatusBarStyle` is declared as an empty string

[`Info.plist`](../../../frontend/src-tauri/gen/apple/canari_iOS/Info.plist) sets `UIStatusBarStyle` to
`""`. That is not a valid value, and the key is ignored regardless unless
`UIViewControllerBasedStatusBarAppearance` is `false`, which is not declared. **A dead declaration is
worse than none**: it reads as though the subject had been handled.

### 1.3 The launch background is the product's colour on Android and Apple's on iOS

Android paints `@color/app_background` - `#FFF9FBFF` light, `#FF070B12` night - through
[`themes.xml`](../../../frontend/src-tauri/gen/android/app/src/main/res/values/themes.xml), whose
comment records that the flash it replaced was the parent theme's grey, inherited "by luck rather
than by choice".

iOS paints `systemColor="systemBackgroundColor"` in
[`LaunchScreen.storyboard`](../../../frontend/src-tauri/gen/apple/LaunchScreen.storyboard). It does
follow light and dark, but it follows the SYSTEM's palette, not this product's.

### 1.4 The WKWebView's background is never set

Android makes the WebView transparent - `webView.setBackgroundColor(Color.TRANSPARENT)` in
`onWebViewCreate` - explicitly so the window background shows through while SvelteKit hydrates,
"eliminating the ~1s black flash on startup".

**There is no iOS peer.** `opaque`, `backgroundColor` and `scrollView.backgroundColor` appear nowhere
in `gen/apple/Sources` against the WebView (the single `format.opaque = NO` in `canari_push.mm` is an
avatar rasteriser). So the mechanism that removes the startup flash on Android has never existed on
iOS. **Second candidate for the black bands.**

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

### 2.1 Keyboard media is an EVENT on Android and a POLL on iOS - and not the same feature

Android hooks the real pipeline: `setOnReceiveContentListener` plus
`InputConnectionCompat.createWrapper`, so a Gboard GIF commit is delivered as it happens
([`KeyboardMediaBridge.kt`](../../../frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/KeyboardMediaBridge.kt)).

iOS polls `UIPasteboard.general.changeCount` every 0.5 s on an `NSTimer`
([`KeyboardMediaBridge.mm`](../../../frontend/src-tauri/gen/apple/Sources/canari/KeyboardMediaBridge.mm)).

Two separate problems, and the second is the larger one. It is a clock in a path that has an event
available, against the standing directive that everything be deterministic rather than timed. **And
it captures what was PASTED, not what the keyboard COMMITTED** - the same name over a different
feature, which is how a gap survives a checklist.

### 2.2 Two six-second waits in the iOS push path

`dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 6 * NSEC_PER_SEC))`, twice, in
[`canari_push.mm`](../../../frontend/src-tauri/gen/apple/Sources/canari/canari_push.mm). No Android
peer. Ask of each what it would mean if it fired.

### 2.3 The MLS state lock does not cross processes on iOS

[`MlsStateLock.kt`](../../../frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/MlsStateLock.kt)
is a `ReentrantLock`, and that is SOUND on Android: the FCM service and WorkManager run in the same
process, and the file says so.

On iOS the NSE is a **separate process**, and the app's `g_mlsStateLock` is an `NSLock`, which cannot
coordinate with it. `NotificationService.swift` states that the extension "does not need to share the
app's lock" and keeps its own for the FCM cache. **That is an assertion, not a measurement**, and both
sides write mirrored state (`CanariMirrorPushStateToAppGroup` on one side, the NSE's decrypt on the
other). If it is true, the reason belongs in writing next to the claim; if it is not, the failure is a
corrupted mirror that surfaces only as a decrypt that should have worked.

### 2.4 Nothing re-registers iOS after a reboot or an app update

Android has
[`CanariBootReceiver.kt`](../../../frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariBootReceiver.kt)
on `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`: it re-registers the push token and drains the outbox
with no user action.

iOS cannot have a peer - the OS offers no such wake - and **nothing compensates**. After an OS update
or an app update the device waits for the user to open the app. Worth knowing before reading a
"missing push" report as a defect.

### 2.5 Four notification channels against one category

Android creates `MESSAGES`, `SOCIAL`, `FORMS` and `CALLS`
([`CanariApplication.kt`](../../../frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariApplication.kt)),
each independently tunable by the user in system settings. iOS has one category carrying the quick
actions, and the user's control is all-or-nothing.

Platform-inherent, and listed anyway because it is a PRODUCT difference rather than a plumbing one:
"silence the social notifications but keep the messages" exists on one platform only.

### 2.6 French in developer-facing logs

`canari_push.mm` logs `BGTask outboxRetry planifie` and `handler enregistre` - French, unaccented, in
code the repo rule requires to be English. Three lines, no behaviour.

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
