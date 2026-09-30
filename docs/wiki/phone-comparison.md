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
| D | **The iPhone renders everything ~1.25x larger** at the same ~390 pt viewport: fewer items per screen, more wrapping ("Decouvrez les associations de la communaute" on 3 lines). Cause unknown (iOS text size, `text-size-adjust`, viewport): check Settings > Display on that iPhone first. | iPhone | all |
| E | **The WebKit form accessory bar** (up/down arrows, OK) takes ~45 pt above the keyboard on every text field. | iPhone | search, composer |
| F | Header icon buttons are 45 px and filter pills 32 px high: fine on iOS (44), under Material's 48. | Android | header, feed |
| G | Fits everywhere else: no horizontal scroll, no visible scrollbar, no clipped text on agenda, shop, associations, forms, notifications, discussions, communities, the apps-grid popover. | both | - |

Test data, not a defect: the first feed post carries an embedded screenshot of another app.

Not reached: chats and salons (need an open conversation), events, lists, documents, directory, admin
(role), "Nos autres sites" beyond the popover. They need data created on the local stack first.

## What to do next

1. Install a release-mode APK against the local stack, then redo startup and scroll - or the Android numbers stay debug numbers.
2. Reset the feed filter before each run, extend the tour to chat, lists, documents, directory and events.
3. Give the iPhone a way to read the renderer (the release WebView is not inspectable): today scroll smoothness is Android-only.
4. Decide what to do about findings 1-4; they are the ones a user sees.
