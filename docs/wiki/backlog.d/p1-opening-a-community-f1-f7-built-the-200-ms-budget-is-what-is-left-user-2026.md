## P1 - Opening a community: F1-F7 BUILT, the 200 ms budget is what is left (user, 2026-10-14; state re-read 2026-10-22)

target: 1.7.0

_2026-11-17, the owner: this entry CLOSES for `1.7.0` once #3769 (merged 2026-11-17) and its phone
reading are in; the 200 ms budget itself moves to the
[slow-link chantier](slow-link-local-first-chantier.md) (`1.7.1`)
([decisions](owner-decisions-of-2026-11-17.md))._

**Re-read 2026-11-11.** The goal (user): on a slow network and a poor phone, opening a community is almost instantaneous - rail, salons and a salon opened before **<= 200 ms from local state, with 0 request on the path**. F1-F7 are built, and since 2026-11-02 the salon mount was cut three times (#2914, #3117's 20-row reveal, the per-bubble and per-day work, the composer's warm-up). **Latest reading, Mi 9T, `1.6.8-alpha.1`, 2026-11-08, cold Wi-Fi 1x medians: tap to rail and salons 452 ms, salon to pane 601, salon to messages 1041, cached reopen 314; the budget is met on NO row** ([readings](../frontend/community-open-budget.md#the-budget-reading-on-168-alpha1-2026-11-08-the-reopen-halved-the-first-open-did-not-move)). **Next:** a `--chain` / `--profile-salon` run of the cold first open to name the ~190 ms before the pane, then the items of [section 7](../frontend/community-open-budget.md#7-not-measured-and-owed) (the warm resume at 4x, iOS). Re-readable now on the bench with `bun tools/cold-start/community-open.mjs` on the current pre-release.

**2026-11-17: the four closed overlays of every bubble are mounted on its first touch** (step 1 of the
[ordered list](../frontend/community-open-budget.md#the-composers-idle-warm-up-ran-a-60-ms-task-inside-every-first-open-and-what-is-next-2026-11-09);
[measured on the desktop bench](../frontend/community-open-budget.md#the-four-closed-overlays-mounted-on-first-intent-2026-11-17):
a gain the size of the profile's ~0.3 ms a bubble at x4, inside this machine's noise). The last phone
reading (`1.6.9-alpha.1`, 2026-11-09) still puts a cold first salon open at 891 ms to its first
bubble against 200. **What is left, in order, sized honestly:**

1. **The Mi 9T reading on the pre-release that carries the overlays** - `community-open.mjs` cold and
   warm, then `--profile-salon` and `--chain` on the cold first open, to name the time before the pane
   and the 627 ms of long tasks (one bench sitting, half a day). It decides step 3.
2. **The `Icon` count and cost** - count the `@lucide/svelte` icons a first open mounts, then draw the
   per-bubble and per-row ones as plain inline SVG if the count says so (one to two days, desktop
   bench first).
3. **Whatever the chain names** - the layout of the first frame (111 of 279 ms on the bench, text
   shaping) and the cold open's 49 API calls are the two candidates; neither is sized until step 1.
4. **The [section 7](../frontend/community-open-budget.md#7-not-measured-and-owed) readings** - the warm
   resume at 4x and the iOS protocol (a day each).

The 200 ms on every row is several weeks beyond the step above, not one pull request.

**Mi 9T, 2026-11-17 (`1.7.0-alpha.8`, [readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha8-both-phones-one-sitting)), step 1 in part:** `community-open.mjs --runs 3 --cpu 1 --net none` on `BancOuverture-1`, cold medians (worst): tap to rail and salons 915 (1093) ms, salon to pane 433 (564), salon to messages 865 (966), cached reopen 354 (363), 49 API calls / 330 kB, long tasks 898 ms; warm: 364 / 316 / 323 / 380, 4 calls. A different community from the 1.6.9-alpha.1 reading, so not comparable to its 891 ms. **Not run:** `--profile-salon` and `--chain`, so step 1 still owes the naming of the time before the pane.
