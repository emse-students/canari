# Mi 9T vs iPhone 12 - first comparison (2026-09-30)

Both phones ran a LOCAL build against the local stack, same account, same Wi-Fi. **Findings only:
nothing here was fixed.** Screenshots are in the rig's state dir (`F:\Programmation\canari-harness\ios-bench\`),
not in the repo - they show a campaign account. The bench is [`tools/phone-bench/`](../../tools/phone-bench/bench.py)
(`bench.py calibrate|tabs|scroll|startup|weight`, `crawl.py`); the iPhone side is driven by
[`tools/ios-device/`](../../tools/ios-device/ios.mjs) ([mobile](frontend/mobile.md#a-build-for-the-phone-on-the-bench)).

## Read this before any number

- **The Mi 9T runs a DEBUG build** (`DEBUGGABLE`, 697 MB APK); the iPhone runs a release-type archive.
  Android startup and smoothness are debug numbers and **must not be read as an Android defect** until a
  release APK pointed at the local stack is installed. Store sizes below are the real ones.
- **Two different clocks.** Android: `dumpsys gfxinfo` is the renderer's own frame time; screen changes come
  from `screenrecord`, which sends NOTHING while the screen is still (a capture started on a static page holds
  0-2 frames, so the bench takes a `screencap` baseline). iPhone: MJPEG stream at ~28 frames/s from WDA.
- **Harness floor.** `adb input tap` returns in ~50 ms; a WDA tap blocks 0.5-1.7 s (it waits for the app to be
  idle). Both timings are "dispatch -> first changed frame on the host", so the iPhone's ~20 ms frame spacing
  and WDA's quiescence wait are inside them.
- The per-element audit (`audit.py`) is too noisy to trust (the Android dump keeps pages hidden behind a modal); verdicts come from screenshots.
  behind a modal, so the same 25 findings repeated on every screen. Verdicts below come from the screenshots.

## Weight

| | Mi 9T | iPhone 12 |
| --- | --- | --- |
| Store package (v0.18.31) | APK 51.0 MB, AAB 29.4 MB | IPA 48.4 MB |
| On this bench | APK 697 MB (debug, all in `base.apk`) | IPA 44.8 MB, binary 36 MB |
| Memory (PSS, feed) | 247 MB | not measured yet |

## The tour: 15 screens, both phones, every step verified (`tour.py`)

Each row taps to the screen, then PROVES arrival (an expected text present, the root page's text gone).
**15 of 15 reached on both phones.** `first` = tap -> first changed frame, `settled` = last changed frame,
ms, one run each (the tab rows of `bench.py tabs` are medians of 3 and agree within ~40 ms).

| Screen | Mi 9T first / settled | iPhone first / settled |
| --- | --- | --- |
| Tab Communities | 240 / 439 | 244 / 623 |
| Tab Discussions | 250 / 564 | 243 / 631 |
| Tab Dashboard | 126 / 543 | 213 / 485 |
| Profile (dashboard) | 217 / 541 | 289 / 462 |
| Settings | 322 / 604 | 300 / 474 |
| Agenda | 260 / 525 | 284 / 474 |
| Shop | 248 / 514 | 287 / 475 |
| Associations | 201 / 484 | 272 / 459 |
| Forms | 199 / 484 | 324 / 486 |
| Apps grid (popover) | 242 / 387 | 297 / 360 |
| Notifications | (*) / 521 | 306 / 496 |
| Composer | (*) / 577 | 341 / 467 |
| Search | (*) / 1940 | 572 / 849 |
| Profile (header) | (*) / 640 | (*) / 457 |
| Tab Feed (first load after the PIN) | 322 / 2072 | 341 / 3435 |

(*) `first` under 20 ms comes from the feed still animating after the previous step, not from the tap: read
`settled` only. **Navigation is a tie within the harness floor** (~250 ms first change, ~450-650 ms
settled, on a debug Android). The two real gaps: search settles in 1.9 s on Android against 0.85 s on iPhone
(Android's keyboard animation is inside it), and the first feed load is 2-3.4 s on both.

Warm start (`bench.py startup`): Android first 450-480 ms / settled 3.5-3.9 s, iPhone 220-390 ms / 0.53-0.57 s -
a debug Android build, not a verdict. Feed scroll renderer (Android, `gfxinfo`): p50 16-17 ms, p99 29-42 ms,
about 8 janky frames of ~150; the iPhone stream (33 ms frame gap) cannot resolve smoothness.

## Layout - every screen fits, and what does not

Read off side-by-side screenshots of the 15 verified screens. **Design differences are accepted** (the
floating "liquid glass" bar is deliberate on iOS); the bar for each line is "works, fluid, readable".

| # | Finding | Phone | Screens |
| --- | --- | --- | --- |
| A | **The floating tab bar is drawn OVER the composer**, hiding its attachment row and the "Publier" button (a yellow edge shows through the glass). The action that matters on that screen is covered. | iPhone | composer |
| B | **The composer's attachment row is cut on the right** ("Sondage"): it scrolls sideways with nothing saying so. | both | composer |
| C | **The glass bar covers the bottom of long pages** (the last dashboard card "Formulaires", profile "Cotisations", settings "Code PIN") and the content shows through it. Reachable by scrolling, but unreadable at rest. | iPhone | dashboard, profile, settings |
| D | **Not an iPhone defect - the Mi 9T draws SMALLER than standard.** The iPhone is at the standard display zoom (390 pt wide); the Mi 9T's WebView reports 436 CSS px instead of its nominal 393, because MIUI's "display size" is reduced on this phone. The iPhone's Dynamic Type setting could not be read from the Settings tree. | Mi 9T | all |
| E | **The WebKit form accessory bar** (up/down arrows, OK) takes ~45 pt above the keyboard on every text field. | iPhone | search, composer |
| F | Header icon buttons are 45 px and filter pills 32 px high: fine on iOS (44), under Material's 48. | Android | header, feed |
| G | Fits everywhere else: no horizontal scroll, no visible scrollbar, no clipped text on agenda, shop, associations, forms, notifications, discussions, communities, the apps-grid popover. | both | - |

Test data, not a defect: the first feed post carries an embedded screenshot of another app.

Not reached: chats and salons (need an open conversation), events, lists, documents, directory, admin
(role), "Nos autres sites" beyond the popover. They need data created on the local stack first.

## Every screen size (web audit, `viewports.mjs`)

The logged-in W1 browser is resized in place over CDP and each of 34 static routes is audited in the DOM at
12 sizes: Fold cover 280, SE 320, 360, iPhone 12 390, Mi 9T 393 **and 436 (what its WebView really reports:
1080 px / 2.477, MIUI's display size, not / 2.75)**, iPhone Max 430, phone landscape 844x390, tablet
portrait 768x1024 and landscape, laptop 1366, desktop 1920 - plus text zoom 150 % (390 and 320 wide) and
200 % (360 wide). Matrices are in the state dir (`viewports-summary*.md`), one screenshot per route and size.

- **No horizontal overflow on any route at any size or text zoom** (class H = 0 everywhere, including 280 px
  and 200 % text). This is the good news of the pass.
- **Small tap targets (class T) are the one recurring finding**, and only on touch sizes. The same
  components each time: the feed filter pills (Associations / Suivis / Tout, 34 px), the header links
  ("Accueil"), the admin "Moderation" buttons, the legal pages' "Retour" (59x16) and their table-of-contents
  links (20 px high, 13-16 per page), and on tablets the header icon buttons (38 px and "Acceder au profil"
  24x24). At 150-200 % text most of them pass, because the targets grow with the text.
- The bottom-nav labels are clipped to 1 px by design (icon-only bar): not a finding.
- Routes that land elsewhere for this account: `documents` -> dashboard, `admin` -> dashboard and the
  `admin/*` pages -> `/admin` or `/posts` (W1 is not an admin): **those pages are NOT covered**.

## Overlays and the system bars

**Android** (`insets.mjs`, the real WebView over CDP, both navigation modes): the WebView reports its safe
areas, and they change with the mode - **top 34 px in both, bottom 24 px with gestures and 49 px with the
three buttons**; the viewport is 436x945 CSS px either way. The page, every overlay opened by an opening
verb (new conversation, add a channel / a community, post menus ...) and the tab bar stayed inside them; the
dialogs are centred cards with consistent margins. What the audit flagged (an interactive element under the
fixed bottom bar, e.g. "Se deconnecter" at the end of settings, the post action row) are elements at the
bottom of a SCROLLABLE page, cleared by the bar's reserve once scrolled - not a defect. Two routes did
not complete in three-button mode (`settings` onwards: a screenshot timeout), so **three-button coverage is
posts to profile only**; gestures are covered to `legal/cgu`.

**iPhone** (`overlays_ios.py`, the accessibility tree): 15 overlays opened from 10 screens, rectangles
checked against the status bar (47 pt), the home indicator (34 pt) and the tab bar. Real: the composer's
"Sondage" switch is laid out at 379..480 pt on a 390 pt screen (90 pt off the right edge), and Settings
has a control under the tab bar (finding C). The other flags were the iOS keyboard's own keys and the feed
post buttons, not the app. **The automated check cannot see finding A** (the composer's Publier under the
glass bar): the bar's rectangle contains the button, so the rule counted it as part of the bar - A stands on
the screenshot and on geometry (Publier sits at x = 0.80, exactly where the Dashboard tab is) and has NOT
been confirmed by tapping it.

**The fullscreen media viewer is fine - it was the tour.** The first feed post carries a SCREENSHOT of
MiGallery (test data). Its "Plein ecran" opens `MediaLightbox`, which shows a Back button on every
platform; a single tap on the image hides the controls (`chromeHidden`), and the tour's tap did exactly
that - an empty tree, read as "no way out". Not a finding.

## What is covered, and what is not

Covered: 15 screens on both phones, 34 routes x 12 sizes + 3 zoom levels on the web, 19 Android routes with
their opening overlays in gestures (and 6 in three-button mode), 10 iPhone screens with their overlays.

Not covered, in order of what a user meets first:
1. Screens that need data: chat and salon views, a post's detail, events, lists, documents, directory
   detail, forms answering - create the data on the local stack first.
2. Admin pages: need an admin account on the local stack.
3. iPhone with larger Dynamic Type, landscape, and an iPad; Android with the system font at 200 %.
4. Three-button mode after `profile`; every overlay that needs a long-press or a swipe (message actions,
   swipe-to-reply).
5. Scroll-to-the-end checks on the phones (whether the bar's reserve clears the last card), and any timing
   on the release-mode Android build (still debug).

## The correction plan - where it stands (2026-09-30)

Decided with the user: one pull request per lot, one local hardware build per lot before merging,
design differences between iOS and Android accepted, test data created on the LOCAL stack only.

| Lot | What | State |
| --- | --- | --- |
| 1 | The native iOS tab bar hides while anything covers the screen; the composer's attachment row fades where it scrolls (findings A, B) | MERGED #1240, read on both phones |
| 2 | iOS safe areas: WebKit read every `env(safe-area-inset-*)` as 0, so "Publier" sat in the home indicator (finding C was NOT a defect: the last card clears the bar) | MERGED #1242, read on the iPhone - [parity §1.1](frontend/android-ios-parity.md) |
| 3 | 44 px touch targets; a stacked list takes a real 44 px row, never `.tap-target` | MERGED #1243, read on the Mi 9T, NOT on the iPhone |
| 4 | Readability: the iOS keyboard accessory bar (finding E, ~45 pt above every keyboard) | OPEN - the user has not decided; removing it is offered, last |
| 5 | Coverage: the screens that need data, admin pages, Dynamic Type, landscape, iPad, Android at 200 % font, long-press and swipe overlays, three-button mode after `profile` | OPEN |

**Tools the campaign left, each one a measurement that used to be a guess:**
- `bun insets.mjs --mode ios --ios` reads the iPhone over `pymobiledevice3 webinspector cdp --port 9444`
  (run the bridge first; it needs a BENCH build - `ios.yml` with `local_url` adds `tauri/devtools`).
- `pymobiledevice3 syslog live` reads the iPhone's native log with no Mac; `CanariIOS` lines are there.
- `viewports.mjs` class `Z` reports a control whose drawing lands in a neighbour's `.tap-target` box.
- **Signing in on a RELEASE IPA (no CDP), by WDA only** (2026-09-30, dev estate): the login card's
  "Connexion externe (service-account)" opens the authentik form on `auth.canari-emse.fr` in a system
  sheet (an iOS consent prompt comes first: "Continuer"). Type the login, press Return, type the
  password, press Return - through `POST /session/{sid}/wda/keys`, values read from `accounts.mjs`
  inside the script, never on a command line. **Tapping "Continuer" instead of pressing Return added
  a character to the password each time and the form answered "Mot de passe invalide"**; clear the
  field with `\b` keys and retype once. Never the CAS page.
- **The dev estate does not share a campaign account's encryption state**: `canari-test-alpha` was
  refused its campaign PIN there ("messages enregistres ... n'ont pas pu etre ouverts"), so on
  2026-09-30 the user authorised "PIN oublie ? > Reinitialiser", a test account on the dev copy, and the
  PIN was re-created as the SAME campaign PIN (`pin.mjs`) so nothing else moves. Its dev-estate
  message history is gone; prod and the local stack are untouched.

**Owed to the user, none blocking:** whether a RELEASE APK may be installed on the Mi 9T (a different
keystore, so the uninstall loses the A1 MLS enrolment) - until then Android timings are debug-build
timings; revoke the App Store Connect key `U7X7X373G5`; disable Web Inspector on the iPhone; the bench
IP `192.168.1.32` comes from DHCP. **Two folders the OS will not delete** (`canari-wt-brace`,
`canari-wt-lot3`, a locked `.node` file in `node_modules`) are safe to remove by hand.

## The user's guided pass on the release IPA (2026-09-30) - the list, in the order given

The user walked the iPhone build (dev estate) and dictated what to fix, for "a release aux petits
oignons". Status is kept here until each item is merged; the release is cut only when all are.

| # | What the user said / what was seen | State |
| --- | --- | --- |
| U1 | "Environnement de test" banner takes ~180 px on EVERY screen and cannot be closed: give it an X | WRITTEN - closes for the session only (it was permanent on purpose, [dev-environment](infrastructure/dev-environment.md)); not yet read on the phone |
| U2 | Black bars top (status bar band, the page stops under it) and bottom (a black strip below the last card on the feed): "je veux une experience belle et immersive" - the page must draw under both and publish the top inset like the bottom one | WRITTEN (top inset, theme-following status bar) - the bottom strip seen on the feed was the PIN modal closing, to re-check; not yet read on the phone |
| U3 | Conversation: the glass header is drawn OVER the banner, the name pill wraps onto two lines, the "+" floats alone above the composer row (110 px up, 164 px with the keyboard open - not a constant offset, so not a transform) and is not aligned with the mic and the field. Cause NOT found by reading the CSS; needs the live DOM, hence a bench build (runs 36766494888 release-like, 36766646478 bench) | OPEN - investigating |
| U4 | The bar above the keyboard (up/down arrows and a check) is iOS's form-navigation accessory bar; it is removable | WRITTEN - not yet read on the phone |
| U5 | Walk the rest of the app for other graphical defects (seen so far: Communautes tab has its title and the "+" tile offset, profile shows a lone settings icon under the school chip) | OPEN |
| U6 | The PIN sheet is cut on the iPhone (keypad's last row and options under the footer): full screen on phones, prose and key height trimmed under 800 px of height | WRITTEN - not yet read on the phone |
| U7 | Black band and rounded corner above the keyboard = the window's own black | WRITTEN (window ground follows the theme) - not yet read |

**Bench traps met on the way:** the PIN sheet KEEPS the digits typed on the unlock keypad when it switches to "choose a PIN" after a reset (6 + 6 = a 12-digit PIN that then matches nothing) - clear with the backspace key first and read the dots; the test banner is 4 lines on a phone, so its detail text should go on narrow screens.

## What to do next

1. Lot 5, in the order of "What is covered" above: create the data on the local stack, extend `tour.py`
   (`SCREENS`) and `overlays_ios.py`, then read each new screen with `insets.mjs` on both phones.
2. Lot 4 when the user decides.
3. The release-mode APK once the user allows it, then redo startup and scroll.
