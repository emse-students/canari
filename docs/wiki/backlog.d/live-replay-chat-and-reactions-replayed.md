## The chat and the reactions of a live replayed in sync with the video, as on Twitch (owner wish, 2026-11-20; designed, not built)

target: 1.10.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

Asked on 2026-11-20 (*"ce serait bien que les messages/réactions diffusés pendant le live puissent être
présents à la rediffusion aussi, comme Twitch"*). It reverses one line of the replay design: **"the chat is
not replayed"** ([live-replays](../live-replays.md), the request of 2026-11-07, and C2 of
[lives](../services/lives.md#live-chat-and-floating-reactions-wp-l6)). Nothing below is built; the open
questions are for the owner, each with a recommendation. Charter: principle 1 (your messages are yours,
[principes](../../principes.md)) is the one this touches.

### What exists today (read in the code, 2026-11-20)

- **Stored: yes, in PostgreSQL, for the length of the live only.** Chat lines are `live_chat_messages` (`seq`,
  `authorId`, `clientId`, `sealed`, `createdAt`, `hiddenAt`, `mentionedUserIds`), reactions
  `live_reaction_bursts` (`seq`, `userId`, `burstId`, `window`, `counts`, `taps`, `createdAt`), both with a
  CASCADE foreign key on the live. `publishReplay` DELETES both in the very transaction that creates the replay
  post (a reported line lives in its own table, `live_chat_reported_lines`, under its own rule).
- **Encrypted: the line, with the live key; the reactions, no.** A line is sealed AES-256-GCM under the LIVE key
  (AAD: label, live id, `clientId`, author id), so the store holds ciphertext, but **social-service holds the
  live key** (sealed at rest, opened by `openLiveKey`): this is integrity of place and author, not
  confidentiality against the server or a database copy (the stated limit of C12). Reactions are plaintext
  counts per 2 s window; the poll never exposes a tapper.
- **Timestamps: yes, on the database clock.** A line has `createdAt` and a per-live `seq`; a burst has
  `createdAt` and `window` (2 s steps since the live started). The replay's segments carry `createdAt` on the
  SAME clock and `GET /api/lives/:id/replay` already derives `atMs = createdAt - first createdAt`, so a line maps
  onto the replay timeline with the same subtraction, no client clock involved.
- **The audience of the replay is the live's**, and the replay route already hands every viewer the live key.

### The design

1. **What is kept.** For a live that keeps a replay, the lines and the reaction windows are NOT deleted at
   publication. They stay where they are, hanging on the live row, so **their deletion is the replay's**: the
   purge waits for the replay post and the cascade removes them with the live. An early end (a cut, the cap, an
   erasure) goes the same way, and the organiser's switch deletes them in its own transaction ("anything
   derived"). No clock, no second retention. Two changes at the publication: reaction rows are folded to ONE row
   per window with the counts and NO account id (a replay needs the sum, never who tapped), and the lines of a
   viewer the broadcaster REMOVED from the live are erased.
2. **Whose data.** A line is its author's: an account erasure deletes it (the erasure statements already cover
   the table by `authorId` and must keep covering whatever the replay reads); the broadcaster and staff can hide
   it (the hide erases the ciphertext and leaves a tombstone, C14); **the author can delete their own line from
   the replay** (new, idempotent, same tombstone). A reported line keeps its own table and rule.
3. **Consent (principle 1).** A viewer wrote into a chat promised ephemeral, to an audience present at that
   time; a replay shows it for 3 days to anyone in the audience. Decision 1 forbids telling viewers whether THIS
   live is replayed, so the notice cannot be per live (question 1).
4. **Encryption.** Unchanged: lines stay sealed under the live key, the replay client opens them with the key the
   replay route already returns, the server opens a line only for a report. No new place where the server reads
   a message. Reactions stay plaintext sums.
5. **Reading and sync.** One new route, `GET /api/lives/:id/replay/chat?from=<seq>`, paged, `no-store`, behind
   the replay post's own visibility gate (the same 404 for an outsider, a block either way, a removed viewer, an
   expired replay), answering `{ lines: [{ id, clientId, authorId, sealed, atMs }], reactions: [{ atMs, counts
   }], nextFrom }`. A blocked author's lines are filtered per reader in the SQL, as on air (C10). `atMs` is
   computed on the database clock like the segments'; lines older than the first kept segment (the 3-hour trim,
   D1) are dropped. The client schedules lines and floating reactions off the player's media time, through the
   segment seek map it already has: a seek re-draws the last lines and restarts the reactions from the target.
6. **Deletion together with the replay.** By construction (point 1): one lifetime, one deletion path.
7. **Not in scope.** A replay is read-only: no new line, no new reaction; no push, and no mention notification
   again (a mention fired when the line was sent).

### Questions for the owner (1, 2, 3 and 8 decided on 2026-11-20; 4-7 and 9 still open, recommended option first)

1. **Consent of the viewers. DECIDED (owner, 2026-11-20): (a)**, the fixed line "Vos messages peuvent être conservés avec la rediffusion" under the composer on every live, plus the author deleting their own line from the replay. (a) **A standing line in the chat composer, on EVERY live: "Les messages peuvent
   être conservés avec la rediffusion"** - true of all lives, so it does not say whether this one is replayed
   (decision 1 holds), plus the author's own delete; (b) tell viewers per live (contradicts decision 1); (c) keep
   only the lines of people who ticked an opt-in (heavy, the replay chat would be nearly empty).
2. **One switch or two. DECIDED (owner, 2026-11-20): (a)**, one switch; off deletes the chat and the reactions too. (a) **One: "Rediffusion" off deletes the chat too, on keeps both**; (b) a separate
   "replay the chat" switch beside it.
3. **Reactions. DECIDED (owner, 2026-11-20): (a)**, anonymous sums per window. (a) **Replay them as sums per window, with no account**; (b) not replayed, only the chat.
4. **The delay.** A viewer sees the picture 5-10 s after it was sent, so a line answers a picture older than its
   arrival. (a) **Measure it on the phones first (one reading) and shift every line by one constant server
   value**; (b) show lines at their arrival time, unshifted.
5. **Who sees a line in the replay.** (a) **Everyone the replay is shown to, minus blocks either way and minus the
   lines of removed viewers**; (b) only viewers who were already present (not knowable cheaply, and not what the
   live promised either).
6. **Hide.** (a) **The broadcaster and staff can hide a line from the replay, and the author can delete it**; (b)
   author only.
7. **A bound.** A line is at most 928 bytes and rate-limited per account (3 per 5 s). (a) **Keep every line of the
   kept window, and add a per-live bound only if the first week's measurement asks for one**; (b) cap at the last
   N lines now.
8. **Order. DECIDED (owner, 2026-11-20): (a)**, `1.7.3`, after `1.7.2`. (a) **After 1.7.2 and the owner's order of 2026-11-11** (the slow-link chantier, then the oldest
   entries): this entry says 1.7.3; (b) before them, because it was asked.
9. **The texts.** The privacy policy "Directs" section, the register rows for the live chat (C19, C20) and the
   composer line of 1(a) change with it; `LIVE_RULES_VERSION` 4 only if the owner wants broadcasters to
   re-accept. Recommended: change the texts in the same pull request as the feature and switch it on after the
   readings, as the replay itself was.
