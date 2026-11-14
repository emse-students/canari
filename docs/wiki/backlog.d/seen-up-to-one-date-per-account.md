## P3 - "Seen up to": one server-side date per account, for the "Nouveau" badge and a real "unseen" first in Pour toi (owner, 2026-11-10, after 1.6.9)

target: 1.10.0

**Decided by the owner on 2026-11-10 (decision B of the 1.6.9 feed tabs). To build AFTER the
`1.6.9` stable; not built.**

**What exists.** The "Nouveau" corner badge of the feed is drawn from ONE per-device instant: the
localStorage key `LAST_SEEN_KEY` (`posts_last_seen_ts`) in `frontend/src/routes/posts/+page.svelte`,
moved forward by an `IntersectionObserver` as posts scroll into view (`lastSeenTs`, `isNew`). Two
devices of one account disagree, a reinstall forgets it, and the server knows nothing of it - which
is why Pour toi's first band is "a followed post under 48 h" and not "a followed post not yet seen"
([posts](../frontend/modules/posts.md#the-owners-decisions-of-2026-11-10), decision 11).

**What is decided.** ONE date per account on the server - "seen up to" - never a per-post history:

- the client advances it (never backwards) as it does `posts_last_seen_ts` today, and reads it at
  start, so the badge agrees across the account's devices;
- Pour toi's first band then becomes "a followed post placed after the reader's seen-up-to date",
  the date read once per ranking and kept in the snapshot, like `asOf` (`for-you-feed.ts`).

**What the build owes:**

- the column or table (a migration), its write endpoint (monotone: a value below the stored one is
  ignored, so two devices cannot move it back), and its read with the feed's first page;
- **one line in the GDPR register** ([register-of-processing](../compliance/register-of-processing.md),
  row C5: the date a reader last scrolled their feed, kept until the account is erased) and the
  matching sentence of the privacy policy - both, in the same pull request;
- the badge read from it on every device, `posts_last_seen_ts` kept only as the offline copy;
- tests: the monotone write on PostgreSQL, the band computed from the date, two devices converging.
