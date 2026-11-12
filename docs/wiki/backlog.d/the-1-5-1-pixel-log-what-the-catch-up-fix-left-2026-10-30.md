## The 1.5.1 Pixel log - what the catch-up fix left (2026-10-30)

One production log of the owner's Pixel on `1.5.1` (cold start, network loss, backgrounding). Of the
lines the catch-up fix did not cover, three are settled since (batch 17, 2026-11-12, read in the
code): `playWhileVisible play() refused AbortError` is classified by `name` and the page's own facts
(`playWhileVisible.ts`, 2026-11-10); `pauseSocket: native disconnect failed` is answered by the frame
accepted before the refusal (`TauriMlsService.ts`, `pausePlatformSocket`, the Mi 9T sign-out reading
of 2026-11-08); `[QUEUE] delivery ... arrived twice` had one cause fixed (single-flight pulls,
2026-11-04, [chat](../frontend/modules/chat.md#one-pull-at-a-time-and-the-one-asked-meanwhile-is-owed-2026-11-04))
and its re-read is a row of the verification table. The boot restore's refusals are
[their own entry](p2-the-boot-restore-opens-the-frame-pipeline-before-any-conversation-r.md).

**What is left: P2 - `derived_inert` after salon sends, 48 lines.** The Svelte 5 teardown race
([architecture](../frontend/architecture.md)) reached from the salon send path: a `$derived` read
after its owner was destroyed. Owed: name the component whose effect outlives the send - the stack
of the first `derived_inert` read on a build with the console kept - then fix that effect's
teardown, with a test that sends and unmounts.
**Not reproduced on the web (2026-11-12, dev `1.6.11-alpha.1`):** the W1 rig profile sent three
messages in a community salon on desktop Chrome, and three more under mobile emulation (412x915,
touch, after a reload) before going back to the list, the console kept with stack traces: no
`derived_inert`, no other warning or error. The Pixel's lines came from the Android WebView, so
the next reading is on the Mi 9T, at `alpha.2`.
