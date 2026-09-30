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
- The per-element audit (`audit.py`) is **too noisy to trust**: the Android dump keeps the DOM of pages hidden
  behind a modal, so the same 25 findings repeated on every screen. Verdicts below come from the screenshots.

## Weight

| | Mi 9T | iPhone 12 |
| --- | --- | --- |
| Store package (v0.18.31) | APK 51.0 MB, AAB 29.4 MB | IPA 48.4 MB |
| On this bench | APK 697 MB (debug, all in `base.apk`) | IPA 44.8 MB, binary 36 MB |
| Memory (PSS, feed) | 247 MB | not measured yet |

## Time, measured (median of 3, ms, tap -> first change / settled)

| Action | Mi 9T (debug) | iPhone 12 |
| --- | --- | --- |
| Switch tab: Communities | 229 / 633 | 244 / 621 |
| Switch tab: Discussions | 219 / 621 | 237 / 617 |
| Switch tab: Dashboard | 258 / 436 | 260 / 493 |
| Open a dashboard page (Agenda, Boutique...) | 200-370 / 560-890 | 270-320 / 430-480 |
| Open search | ~290 / 1800-1960 | 450-590 / 800-950 |
| Open composer | ~260 / 600 | not reached |
| Warm start | first 450-480 / settled 3.5-3.9 s | first 220-390 / settled 0.53-0.57 s |
| Feed scroll, renderer | p50 16-17 ms, p99 29-42 ms, 8-9 janky of ~150 frames | capture only, 33 ms frame gap: smoothness NOT measurable |

Tab and page navigation is a tie within the harness floor. Warm start and search are the two gaps, and the
Android side is a debug build.

## Layout - every screen fits, and what does not

Read off side-by-side screenshots of the four tabs, the six dashboard pages, profile, notifications, search
and the composer.

| # | Finding | Phone | Screens |
| --- | --- | --- | --- |
| 1 | **The iPhone renders everything ~1.25x larger** at the same ~390 pt viewport: headings, cards, pills, body text. Fewer items per screen, more wrapping ("Decouvrez les associations de la communaute" on 3 lines, settings rows on 2). The cause is not established (iOS text-size setting, `text-size-adjust`, or the viewport) - check Settings > Display on that iPhone first. | iPhone | all |
| 2 | **The floating tab bar covers content** and is translucent: the last card of the dashboard ("Formulaires"), the settings "Code PIN" card and the profile "Cotisations" card sit under it and show through. Android's bar is opaque and content stops above it. Nothing pads the page bottom for that bar. | iPhone | dashboard, profile, settings, shop, agenda |
| 3 | **The composer's attachment row is clipped on the right** ("Sondage" cut) - it scrolls sideways with no hint. | both | composer |
| 4 | **The WebKit form accessory bar** (up/down arrows + checkmark) sits above the keyboard and eats ~45 pt on every text field. | iPhone | search, composer |
| 5 | Header icon buttons are 45 px and filter pills 32 px high: fine for iOS (44), under Material's 48. | Android | header, feed filters |
| 6 | No horizontal page scroll and no visible scrollbar on any screen captured. | both | all |
| 7 | The feed shows different content on the two phones (Android: an album embed; iPhone: the Associations filter) - **the filter state was not reset between runs**, so feed comparisons are not like for like. | both | feed |

Not reached (the tap by text failed, to redo): Formulaires on iPhone (under the bar, finding 2), "Nos autres
sites", the composer on iPhone, every chat/DM/salon, events, lists, documents, directory, admin. The tour
also does not yet cover modals beyond the composer and search.

## What to do next

1. Install a release-mode APK against the local stack, then redo startup and scroll - or the Android numbers stay debug numbers.
2. Reset the feed filter before each run, extend the tour to chat, lists, documents, directory and events.
3. Give the iPhone a way to read the renderer (the release WebView is not inspectable): today scroll smoothness is Android-only.
4. Decide what to do about findings 1-4; they are the ones a user sees.
