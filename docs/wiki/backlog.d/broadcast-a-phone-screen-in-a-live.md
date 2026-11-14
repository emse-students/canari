## P3 - broadcasting a PHONE's screen in a live (not built)

target: 1.10.0

**Asked by the owner on 2026-11-14** with the desktop scenes, and kept apart on purpose ("desktop
first"): the scenes that show the screen exist only in a desktop browser, where `getDisplayMedia` and a
mouse are both present ([live](../frontend/modules/live.md#scenes-on-a-desktop-live-owner-2026-11-14)).
A phone keeps its camera, and since 2026-11-14 can flip it, mute its microphone and switch its camera
off on air.

**What it would take, not designed yet:** neither phone engine lets a page capture the screen -
Android's WebView has no `getDisplayMedia`, iOS's WKWebView none either - so it is native work on both:
Android's `MediaProjection` behind a foreground service of type `mediaProjection`, iOS's ReplayKit
broadcast upload extension (a separate process with a 50 MB memory ceiling), each handing frames to the
page or encoding them itself. Both also change what a store reviewer reads in the app. The first step is
a design note weighing that against the use (a phone game, an app demo), before any code.
