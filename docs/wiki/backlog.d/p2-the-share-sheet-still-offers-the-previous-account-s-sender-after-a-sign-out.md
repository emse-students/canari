## P2 - the iOS share sheet still offers the previous account's sender as a person after a sign-out (2026-11-24)

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

_2026-11-26: moved to 1.8.3 when 1.8.2 shipped, after the reading below._

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

**Seen on the iPhone 12, `1.8.0-alpha.6`** ([sitting](../device-verification.md#the-readings-of-2026-11-24-180-alpha6-iphone-12-the-dm-thread-again-the-composer-the-ios-27-sdk-build-the-broadcasters-column-the-voice-note-the-sign-out-row)), reading row 6 of [iPhone message banners as communication notifications](ios-communication-notifications.md). Not fixed here.

**What was seen.** `gamma` had received DMs from `delta` all day, so the notification extension had donated `delta` as a sender. `gamma` signed out from the dashboard: the app logged the sign-out (`logout 200`, `[SHARE] fenced at epoch 2 (signed out)`, `[Push] sign-out ended this device's push registration (ios)`, `signout: MiConnect end-session browser ended (cancelled)`). From Photos, Share on a photo: the share sheet still showed a person suggestion "Canari Test Delta" with the Canari badge, **90 s after the sign-out and again about 3 min after it**. The rule of this feature (the donations "leave with the account", [mobile](../frontend/mobile.md#communication-notifications-owner-2026-11-21)) says the next account's share sheet offers none of the previous account's senders.

**What is NOT known.** Whether `eraseAccountShortcuts` ran at all: its success line, `conversation shortcuts erased, 0 counted`, is `Log.d` in `shareTargetsNative.ts` and the exported in-app log records no DEBUG line, so a silent success and a silent skip look the same (the same lesson as #4023's fall line, which had to move to INFO). The syslog window around 09:21:56 carries no donation-delete line of the app either.

**Hypotheses, in order.** (1) The erase never ran or ran for an empty group: the ticket/owed-mark logic skipped it for this sign-out. (2) It ran, but the donations that feed the share sheet's people row are not in the group it deletes (the extension donates with one group identifier, the share suggestions with another), or the system's suggestion cache outlives the deletion for minutes. The first step is a line at INFO in the erase (`erased n group(s)` / `skipped: <reason>`), then the same gesture again.

**To close it.** Sign `gamma` out after a day of DMs: the share sheet offers no person from the previous account within a few seconds, and the log carries the erase at INFO.

**Fix (2026-11-24, native verified by compiling only).** The chain was sound: sign-out -> `eraseAccountShortcuts` -> `clear_conversation_shortcuts` -> `ShareSuggestions.clearMessageNotifications`, which awaits `INInteraction.delete(with:)` on the extension's group from the app process (a group delete reaches donations made by the extension: same app). Its success line was `Log.d`, hence invisible, so hypothesis (1) could not be told from (2). Two changes: (a) `clearMessageNotifications` now also awaits `INInteraction.deleteAll` after the group delete, and fails (so the erase stays owed on disk and is retried) if either fails; `deleteAll` is used ONLY here, never by the suggestions' publish or clear, which keep deleting their own group; (b) the web side says `conversation shortcuts erased` / `no ... erase owed` / `cleared n` at INFO (`shareTargetsNative.ts`). The erase is still not awaited by `clearAuth`: it waits on the push registration's network end and is owed on disk, so blocking the sign-out on it would trade a clock for a hang.

**Reading owed (iPhone 12).** After a day of DMs, sign `gamma` out: the share sheet offers no person from the previous account within seconds, and the exported log carries `conversation shortcuts erased, 0 counted (signed out)` (or the `already settled - skipped` line, which then points at hypothesis (1)). If the sender persists with that line present, the system's suggestion cache outlives `deleteAll` and the entry stays open with that evidence.

**2026-11-26, `1.8.2` (iPhone 12): FAIL with the erase proven, hypothesis (1) refuted**
([sitting](../device-verification.md#the-iphone-12-readings-of-2026-11-26-evening-182-build-100800209-five-iphone-entries-and-a-read-withheld-until-the-first-touch)). Signed out from the dashboard: `[ShareTargets] cleared 5
(signed out)` and `conversation shortcuts erased, 0 counted (signed out)` at INFO, the native
`clearMessageNotifications: the donation group and every other donation are deleted`. A fresh share
sheet 2 and 3.5 min later no longer offered the app's five suggestions, but still offered `delta` and
`beta`, Canari-badged and faceless. Both deletes answered success from the APP process.

**What is left to tell apart, and the test that does it.** (2a) The leftovers are the notification
extension's donations, and `INInteraction.delete(with:)` / `deleteAll` reach only what the CALLING
bundle donated: the extension is another bundle, so nothing the app runs can remove them. (2b) They
are the system's suggestion cache, which outlives any delete. The discriminator needs a build: have
the extension delete its own group (`messageNotificationsGroup`) when it starts with no account
context (`push_context.json` stripped at sign-out), sign out, send one push to the device while it is
still registered (or sign in as another account and receive one), then read a fresh share sheet. If
the two senders go, (2a) holds and the extension must be the one to erase; if they stay, (2b) holds
and the entry needs another answer (for example donating the sender with no suggestion at all). No
fix is guessed before that reading.

**Built (2026-11-27, `fix/share-sheet-sign-out`, Swift verified by compiling only): the extension
erases its own.** Hypothesis (2a) is taken as the working one, since nothing the app runs could tell
it from (2b) anyway. The notification extension keeps a ledger (`message_donations_owner`, the
account whose senders its group holds, written before every donation). At the start of EVERY run,
it deletes its own group when that owner is no longer the account `push_context.json` names. An
install from `1.8.2` or older has no ledger, so it erases once and writes the era marker
([mobile](../frontend/mobile.md#communication-notifications-owner-2026-11-21)). The share extension
uses a picked suggestion only while an account is signed in, and a leftover sender preselects
nothing in the page (`suggestionIfHeld`, [sharing](../frontend/sharing.md#share-suggestions-ios---lot-s5)).
The build IS the discriminator named above.

**Reading owed (iPhone 12, the first alpha that carries it).**
1. Install over `1.8.2`. On the first push, the syslog carries
   `[CanariNSE] the donations made before the ledger are erased, once`, and a fresh share sheet no
   longer offers `delta` or `beta`.
2. After a day of DMs to `gamma`, sign `gamma` out. Then let one push reach the device: a DM to
   `gamma` sent while the server still holds the registration, or sign in as another account and
   receive one. The syslog carries `[CanariNSE] the donations of an account no longer signed in
   are erased`, and a fresh share sheet then offers no sender of `gamma`'s.
3. Before that push, picking a leftover sender preselects nothing in the page. With nobody signed
   in, the extension logs `[CanariShare] a suggestion was not used: no account is signed in`.

**If the erase line is there and the senders stay**, (2b) holds - the system's suggestion cache
outlives the delete - and the entry stays open with that evidence. If no push can reach a
signed-out device, the senders stay until the next account's first push: record how long that
window is in practice.
