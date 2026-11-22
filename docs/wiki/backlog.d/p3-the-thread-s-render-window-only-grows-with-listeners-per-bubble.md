## P3 - the thread's render window only grows, at 0.13 MB a bubble: reopen it

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](owner-decisions-of-2026-11-17.md))._

`renderWindow.ts` never shrinks the mounted range; each `MessageBubble` adds a non-passive `touchmove` listener. Owed: a DOM-node and listener count on a seeded 5k thread, which decides whether the grow-only window (deliberate, see `renderWindow.ts`) is worth reopening. Still true on `main` (2026-11-11): `MessageBubble.svelte` binds its own non-passive `touchmove`. **The per-bubble `matchMedia` and window `keydown` are gone (#1998, `v1.3.0`)** ([performance-audit](../frontend/performance-audit-2026-10-12.md#findings-5-9-and-10---built-2026-10-17-draft-pr-perfpk13-message-storage)).

_Context, from the former backlog section "Seen in the 2026-10-12 heavy-state performance audit - what is open":_ Ranked, measured and located on [performance-audit-2026-10-12](../frontend/performance-audit-2026-10-12.md). Re-read 2026-11-11: what the pull requests #1771-#1775 left is the item below; the `unreadable_now` exit moved to [the web-checkpoint entry](p2-the-web-checkpoint-is-82-wasm-chacha20-seal-the-hardened-reader-mer.md), whose writer flip it waits on.

**Read 2026-11-14 on dev (`1.6.12-alpha.2`, desktop Chrome, a seeded 5000-message thread):** per mounted text bubble, 28 DOM nodes in the thread, 4 listeners on its subtree (one the non-passive `touchmove`), about 5 page-wide JS listeners and about 0.13 MB of JS heap, linear from 60 to 1732 bubbles. At 1732: 48.5k thread nodes, 280k document nodes, 8.9k JS listeners, 251 MB of heap; 5000 mounted would be about 650 MB (extrapolated). **So the grow-only window is worth reopening for long threads.** The window never reached 5000 because of a separate defect ([older page throws the reader to the bottom](../frontend/local-first-ui.md) (fixed 2026-11-14)).
