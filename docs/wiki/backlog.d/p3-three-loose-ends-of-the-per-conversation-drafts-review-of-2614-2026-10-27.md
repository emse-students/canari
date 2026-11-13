## P3 - Three loose ends of the per-conversation drafts (review of #2614, 2026-10-27)

target: 1.9.0

- **A text restored while an edit is open is LOST.** A refused send answered (or a share landing)
  on the conversation being edited goes through `restoreFailedDraft` into the composer, which holds
  the edited message's text; `cancel`, `confirm` and `reset` then put back the draft saved at
  `begin` (`editSession.svelte.ts`), and the restored text is gone - or, on `confirm`, saved as part
  of the edited message.
- **The salon ledger detour stays, for durability.** A salon text resumed after the member left the
  salon goes back to the ledger (`recordUnsentSalonText`), not straight into that salon's draft
  through the gated writer: the ledger is persisted, the drafts are memory only, so a page closed
  before the next visit would lose it. Simplifying it waits for drafts that outlive the page.
- **A mention dropdown can outlive a conversation switch.** `useMentionAutocomplete` closes only on
  input: type `@ali` in A, switch to B before the debounced search answers or with the list open,
  and the list (A's members) stays over B's composer until the next keystroke.
- **Drafts are never removed when a conversation is left or deleted**: the entry stays in
  `draftByConversation` until sign-out. Memory only and per page life, so small - but a conversation
  re-joined later shows the old text.

[chat](../frontend/modules/chat.md#each-conversation-keeps-its-own-draft-2026-10-27)

**Plan (batch 14, 2026-11-12) - four small client pieces, no agent needed.** (a) A text restored during an edit goes to the conversation's saved draft (`editSession.svelte.ts` `begin`'s copy), not into the composer that holds the edited message, so `cancel` and `confirm` cannot drop or absorb it; a test per exit. (b) The salon ledger detour stays until drafts outlive the page (kept as written). (c) The mention list closes on a conversation switch: `useMentionAutocomplete` gets a `dismiss()` that clears the debounce and a generation counter so a late search answer cannot reopen it, called by `MentionComposerInput` when its conversation key changes. (d) `draftByConversation` drops the entry when the conversation is left or deleted, at the same place the conversation leaves the list.
