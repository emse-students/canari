## Reading owed - DOM nodes and listeners on a seeded 5k thread

target: 1.7.0

`renderWindow.ts` never shrinks the mounted range; each `MessageBubble` adds a non-passive `touchmove` listener. Owed: a DOM-node and listener count on a seeded 5k thread, which decides whether the grow-only window (deliberate, see `renderWindow.ts`) is worth reopening. Still true on `main` (2026-11-11): `MessageBubble.svelte` binds its own non-passive `touchmove`. **The per-bubble `matchMedia` and window `keydown` are gone (#1998, `v1.3.0`)** ([performance-audit](../frontend/performance-audit-2026-10-12.md#findings-5-9-and-10---built-2026-10-17-draft-pr-perfpk13-message-storage)).

_Context, from the former backlog section "Seen in the 2026-10-12 heavy-state performance audit - what is open":_ Ranked, measured and located on [performance-audit-2026-10-12](../frontend/performance-audit-2026-10-12.md). Re-read 2026-11-11: what the pull requests #1771-#1775 left is the item below; the `unreadable_now` exit moved to [the web-checkpoint entry](p2-the-web-checkpoint-is-82-wasm-chacha20-seal-the-hardened-reader-mer.md), whose writer flip it waits on.
