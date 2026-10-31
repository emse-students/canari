## The 1.5.1 Pixel log - what the catch-up fix left (2026-10-30)

One production log of the owner's Pixel on `1.5.1` (cold start, network loss, backgrounding). The
catch-up fan-out and the transport failures logged as errors are fixed on
`fix/catchup-transport-failure` ([offline-and-weak-network section 20](../frontend/offline-and-weak-network.md#20-a-catch-up-that-gets-no-answer-stops-and-the-mailbox-is-owed-to-the-reconnect-2026-10-30)).
These are the lines of the same log that fix does NOT cover, each with its count:

- **P2 - `[QUEUE] delivery ... arrived twice` is back: 31 lines** (`BaseMlsService.ts`, `REPEAT_MEANS`,
  ~line 2219). The ack-before-pull ordering (`ackInFlight`, CHANGELOG) was recorded as closing it; on
  this log the ack landed before the pull and the pull still listed the row. Read which cell of
  `REPEAT_MEANS` the 31 lines are (`pull`/`socket` x `queued`/`done`) before anything else - a `done`
  cell means the server listed a row it had recorded acknowledged, which is the server's to explain.
- **P2 - `derived_inert` after salon sends: 48 lines.** The Svelte 5 teardown race
  ([architecture](../frontend/architecture.md)) reached from the salon send path: a `$derived` read
  after its owner was destroyed. Name the component whose effect outlives the send first.
- **P2 - `[WS] pauseSocket: native disconnect failed`: 8 lines** (`TauriMlsService.ts`, ~lines
  600-603). A regression of #1603, which made the native release on pause reliable; the plugin's
  rejection says why, read it from the log line before touching the code.
- **P3 - `playWhileVisible play() refused AbortError` at WARN: 37 lines** (`playWhileVisible.ts:41`).
  An `AbortError` from `play()` is a pause or a source change interrupting it - the page's own
  decision, not a refusal. Classify it at the catch (by `name`, a DOMException field, not prose)
  and say it at the level of what it is; any other rejection keeps the warn.
- **Raised to P2: the boot restore's absent-conversation refusals** - see
  [the item below](p2-the-boot-restore-opens-the-frame-pipeline-before-any-conversation-r.md):
  **425 absent-conversation refusals, up to 124 unacked frames in one boot** on this log.
