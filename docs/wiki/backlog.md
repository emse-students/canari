# Backlog

**Everything below is SCHEDULED** - the user's decision of 2026-08-18: the backlog and `CLAUDE.md`
are both emptied before the campaign restarts. This file is no longer a parking area; it is the
DETAIL for the queue in `CLAUDE.md`, which carries the order and one line per item. Read the order
there, the substance here, and delete an entry from BOTH when it ships.

The exception is the handful that genuinely cannot be pulled forward - blocked upstream, blocked on
an iPhone that does not exist, blocked on credentials somebody else owes, or post-campaign by the
user's own decision. Each says which it is, and `CLAUDE.md` lists them together at the end of the
queue so that "not scheduled" never has to be inferred.

Severity uses the repo scale: **P1** security, or a user-facing path that is broken - **P2**
correctness, nothing at risk - **P3** hygiene. An item with no severity is a QUESTION, not a defect,
and its first task is to answer the question rather than to write code.

Each entry states what is known, so that picking it up does not start with a rediscovery. **Delete an
entry outright when it ships** - the rule goes to [durable-rules](durable-rules.md), the story to
`CHANGELOG.md`, the mechanism to the wiki page that entry points at. An entry describing its own fix
is an entry nobody trusts to be current.

---

## Security - blocked upstream

### P2 - `libcrux-chacha20poly1305` panic on an overlong ciphertext buffer, in the MLS path

**The only one of the 16 open Dependabot alerts that reaches attacker-controlled input on a path that
matters.** `frontend/mls-wasm/Cargo.lock` pins 0.0.7; the advisory is fixed in 0.0.8. It arrives
transitively as `openmls_rust_crypto` → `hpke-rs` → `hpke-rs-libcrux` → `libcrux-aead` →
`libcrux-chacha20poly1305`, i.e. it IS the HPKE half of the MLS crypto provider, and it processes
ciphertext supplied by whoever sends this device a frame. A panic there kills the MLS client inside
the WASM module. Availability, not confidentiality - no key material is exposed.

**It cannot be bumped today, and this was tried rather than assumed.** `libcrux-aead 0.0.7` pins
`libcrux-chacha20poly1305 = "=0.0.7"`, and a `0.0.x` requirement is exact in Cargo semver, so the
whole chain has to move together:

| crate                      | locked | needed | available                                            |
| -------------------------- | ------ | ------ | ---------------------------------------------------- |
| `libcrux-chacha20poly1305` | 0.0.7  | 0.0.8  | yes                                                  |
| `libcrux-aead`             | 0.0.7  | 0.0.8  | yes                                                  |
| `hpke-rs-libcrux`          | 0.6.1  | 0.7    | yes                                                  |
| `hpke-rs`                  | 0.6.1  | 0.7    | yes                                                  |
| `openmls_rust_crypto`      | 0.5.1  | 0.6    | **release candidates only** (0.6.0-rc.1, 0.6.0-rc.2) |

So closing this alert means shipping a release candidate of the MLS crypto provider. That is not a
dependency bump, it is an openmls provider upgrade with a full MLS re-verification behind it, and it
must not ride along with anything else.

**Re-check when `openmls_rust_crypto 0.6.0` goes stable** - that is the whole condition. Until then
the alert stays open on purpose, and the reason is here rather than in somebody's memory.

---

## Open questions - no code until they are answered

### P2 - what made the profile fetches fail on that device at that moment

**The MECHANISM is closed** (2026-08-16): the swallowed `catch` now accuses, a reconnection clears
`failedAt` because a failure recorded while the network was down is evidence about the network rather
than about the user, a failed lookup answers `null` instead of the label that overwrote names the
caller already had, and `displayName.spec.ts` pins all of it.

**What is owed is the DENOMINATOR, and it is a measurement rather than a change.** The log line that
makes it countable did not exist when the symptom was seen - twice on 2026-08-16, on both platforms,
nine of ten sidebar rows carrying "Utilisateur inconnu" for twenty seconds. Do not assume it is the
same fault as the avatar endpoint, and do not assume it is not.

**The denominator now rides ON the accusation (2026-08-19).** `displayName.ts` counts the lookups
that actually reached the network - a cache hit, the current user, the `system` sender and a lookup
already suppressed by the backoff are all excluded, because counting them would drive the rate
towards zero exactly as the cache warmed and measure the cache rather than the fault - and every
warn now ends `(failed/attempted lookups failed this session, X%)`. One line answers both "did a name
get lost" and "how often does that happen here", which is the question the backoff turns on.
`displayNameLookupStats()` exposes the same numbers to a test or a debug surface.

**Where the number will come from:** the campaign run logs, on both platforms. Nothing here is sent
anywhere - there is no client telemetry and this did not add any - so the rate is read from a device
or a browser console during a run, which is exactly where the symptom was seen. Server-side is not
an option: `GET /api/users/:id` is not request-logged, and a client that never reached the network
would not appear there anyway.

**Then decide about `FAILURE_BACKOFF_MS`.** A high rate argues the two-minute suppression is doing
real work against a refusing server; a rate near zero argues it is a clock hiding a name for two
minutes over a blip that the reconnection listener already handles.

### QUESTION - does an iOS attachment CONSUME the avatar cache file it is handed?

Found 2026-08-17 while writing the initials fallback, and it is a question rather than a defect
because settling it needs an iPhone. `CanariShowLocalNotification` hands `attachmentPath` straight to
`UNNotificationAttachment`, and for an avatar that path IS the durable cache file `avatar_<id>.jpg`
that `CanariFetchAvatar` writes and later re-reads. The NSE does the opposite on purpose: its
`attachImage` copies to a temp file first, carrying the comment *"an attachment URL is
consumed/moved by the OS, so we never hand it a shared cache file directly"*.

Both cannot be right. If the OS really moves the file, the app-process cache is emptied by its own
first hit and every subsequent notification re-fetches - a silent, permanent cache miss that no log
would name, since a re-fetch looks exactly like a first fetch. **What settles it is one device
observation**: notify twice for the same person with the app alive, then look for `avatar_<id>.jpg`
in the app container. If it is gone, the app path copies too, exactly as the extension does. The
initials disc is unaffected either way - it writes to `NSTemporaryDirectory()` on both.

### ANSWERED 2026-08-19 - what a full disk and an evicted store actually do

Both questions were the same shape: five years on a device and ninety days on the web are TIME
bounds, so nothing caps the store by SIZE, and the failure was undesigned rather than designed. Both
were settled by INJECTION and never on the campaign phone (the user's decision, 2026-08-19): the
appliance the campaign depends on is not the place to find out.

**Two defects fell out of asking**, and both are fixed:

- **Tauri caught a failed SQLite open and answered with IndexedDB in the same webview.** The MLS
  state persister writes `mls.bin` to the filesystem and does not follow that choice, so the group
  state would have stayed on disk while conversations and messages moved into the webview's store -
  a client that opens, looks healthy, and whose history does not match its own ratchet. And the
  cause it existed for is the one it cannot survive: the second store is on the same full disk.
- **A blocked IndexedDB upgrade never settled the promise.** `onblocked` fires when another tab
  holds an older version open - neither `onsuccess` nor `onerror` - so `init()` simply stopped, with
  no bound and nothing logged. It now rejects and says which tabs to close. The open failure also
  carries the browser's DOMException as `cause` instead of the string `'IndexedDB open error'`.

**Eviction needs no machinery, and that is a decision.** It drops the whole origin bucket, so the
next open finds no database and hands back an empty store - byte for byte what a browser that has
never seen Canari does, because everything that could have told them apart was in the bucket too. An
empty store IS a new device, the new-device path already exists, history replays from the server and
the MLS state is re-established by enrolling. A client that claimed to know it had been evicted
would be claiming knowledge it does not have.

The shapes are on [frontend/architecture](frontend/architecture.md#when-the-local-store-fails) and
pinned by `src/lib/db/storageFaults.test.ts`. **No SIZE cap is proposed**: a write that fails now
reaches its caller on every backend, which is what the cap would have been protecting.

### Is a MiGallery application worth it?

An open question, deliberately. The Canari formula (SvelteKit + Tauri) transfers, so the cost is
knowable - but MiGallery's value is a gallery that a browser already renders well, and the question
is what an app would add that the web version cannot do. Answer that before estimating anything.

---

## Measurements owed

### P2 - measure EGRESS over time, because two unrelated upstreams stalled in one window

The code half is fixed: `UpstreamUnreachableError` classifies at the throw, so an unreachable host is
a **502 `no-store`** never remembered, while an answer about the URL stays a cacheable 400; and
`OUTBOUND_BUDGET_MS` is the single budget, set on the `AbortController` AND on the undici dispatcher,
so the stated budget is the one that fires. Pinned by `security.controller.link-preview.spec.ts`.

**What is owed is not a code change.** Within one three-minute window on 2026-08-15, two unrelated
upstreams timed out from two different containers (`chat-delivery-service` → Wikipedia at 14:37:02,
`core-service` → gallery at 14:39:58). That is not evidence about either upstream, and it is the
second time this shape has been mistaken for one - the IPv6 reading was refuted by measuring the
components, which all came back healthy. **Measure EGRESS over time rather than the endpoints again**:
the component probes already say each is fine at the moment it is asked, so what is left to establish
is whether these stalls are CORRELATED, which a one-shot probe cannot answer by construction.

**ARMED 2026-08-19.** [`infrastructure/egress-probe/`](../../infrastructure/egress-probe/README.md)
takes a sample a minute - both stalled upstreams, the tunnel back to ourselves, a control at 1.1.1.1,
and the same target from inside `chat-delivery-service` through Node's own fetch - with DNS, connect
and TLS recorded apart from the total. `report.py` prints each conditional rate beside the base rate
it has to beat. Installed in the `canari` crontab, verified writing, `probe.err` empty.

**This item cannot be closed by working on it.** A report over a quiet week says the week was quiet.
Read the ledger the next time a stall appears in a service log; that is the moment the two
hypotheses differ, and the stall will already have been measured.

---

## Communities and permissions

Six entries came out of ONE audit on 2026-08-17, prompted by a user question rather than by a
failure. **All six are closed as of 2026-08-19** and are not repeated here - the last one, two communities
sharing a name, the user closed by decision rather than by code (2026-08-19: it is not a defect).
The five that shipped on 2026-08-18: the mechanism is on
[social-service](services/social-service.md#a-community-always-has-an-admin-or-it-has-no-members-2026-08-18),
the audit and its prod figures on [community-rework](services/community-rework.md), the rule in
[durable-rules](durable-rules.md), and the story in `CHANGELOG.md`. Those six are closed; the entry
below them, a private salon's seed being sealed to the whole community, closed on 2026-08-20.
WP-REGRANT-1, opened 2026-08-21 by the campaign, shipped and was verified on production the same day -
its entry below is kept as CLOSED because the second attempt at the fix is the interesting half. **One
thing IS open here, and it is an observation rather than a finding:** the past-epoch seed frame below.

### OBSERVED 2026-08-21 - a seed frame nobody can open, once per rotation, on every churned salon

**COMM-22, six cycles, SIX of these - one per cycle, and both clients saw the same frame at the same
second:**

```
[RUST::WARN] Past-epoch application frame, unreadable for good: msg_epoch=0 group_epoch=3
  group=c274bb29 err=ValidationError(UnableToDecrypt(SecretTreeError(TooDistantInThePast)))
[GRAINE] frame on c274bb29... is unreadable for good (past-epoch-application) - acknowledged;
  its seed comes back through a history request, not a redelivery
```

`group_epoch` was 3, 5, 7, 9, 11 and 13 - the six epochs the peer's joins produced - and `msg_epoch`
was **0 every time**. So one frame sealed at the group's very first epoch is presented again on every
rotation, to every member, and nobody can open it.

**WHAT IS ESTABLISHED.** The product handles it correctly and says so: the frame is acknowledged, and
the seed arrives instead through the history request - `[GRAINE] answered ... with 1 seed(s)` six
times on the sender, `absorbed 1/1 seed(s)` six times on the peer. The transcript is whole either way:
12 markers of 12 warm AND cold, and a seed per session in the peer's store. **This is not a loss.**

**WHAT IS NOT.** Why an epoch-0 frame is delivered at all. `queued_message` for that group holds no
publish matching it - the 39 rows it does hold are all addressed to the PHONE, which never drained
them and whose APK predates per-salon groups - so nothing in the table accounts for the six
deliveries, which points at a REPLAY rather than at a sender sealing under a stale handle. "Points at"
is not a finding, and the commit log settles nothing either: only two devices ever committed on that
group, W1 and W2, in strict epoch order.

**AND IT DID NOT REPRODUCE.** The next run of the same check, on the same build, after
`cleanup.mjs` had swept three debris communities left by the WP-REGRANT-1 probes, recorded
`pastEpochFrames: []` - zero, over six cycles. The debris is the likeliest reason: the same session
was logging `[GRAINE] undecryptable frame on b0192801... - not acknowledged` in bursts on every load,
b0192801 being a salon group W1 held at epoch 0 while the server had moved on, and those frames
stopped the moment the venue was deleted. **So this is one defect or two**: a client carrying a group
it can no longer follow, and a frame nobody can open.

**THE FIRST HALF IS NOW CLOSED, AND IT WAS REAL** - see
[graine](protocols/channel-encryption.md#a-community-deleted-left-its-seed-carrier-held-for-ever---fixed-2026-08-21).
`b0192801` was a distribution group whose community had been deleted through the product hours
earlier: its `dm_groups` row was tombstoned with both distribution columns cleared, and W1 held it
anyway, because the sweep short-circuited on a LOCAL predicate ("have I recognised this as a seed
carrier") and never read the row - while the purge that owns forgetting such a group enumerates
scopes, and a carrier noted without one is in none of them. It is now read, believed, and dropped
with the note that classified it. That accounts for the redelivery bursts and for the recovery
attempt on every load; it does NOT account for the epoch-0 seed frames, which appeared on a salon
whose community was alive. **The second half stays open and stays unestablished.**

**WHY IT IS NOT PARKED.** A frame nobody can open is a repair on the hot path of every rotation, and
the campaign's own rule is that a fallback is a signal and never a path. It needs ONE probe that
publishes a seed and reads back what the server fanned out, which is a different instrument from the
COMM runners - so it waits for a gap in the ladder rather than for a decision. `comm22.mjs` records
`pastEpochFrames` verbatim on every run, so every future run says whether it is back.

### CLOSED 2026-08-21 - a member let BACK IN to a private salon was never routed again (WP-REGRANT-1)

**Found and FIXED 2026-08-21**, both on production, in `7f11b50e` and `082345b7`. The mechanism and
the second attempt are on
[graine](protocols/channel-encryption.md#the-asymmetry-has-a-third-half-coming-back---fixed-2026-08-21-wp-regrant-1),
the rules it left in [durable-rules](durable-rules.md), the story in `CHANGELOG.md`. Kept here for
one reason: **the first fix was a no-op and passed every gate**, which is the part worth not
repeating. What follows is what was measured before it.

Measured by
`scratch/graine-regrant.mjs` on venue `C22 regrant COMM22-k8qsrko`, salon `4407ec7c`:

| Gesture | Salon group epoch | Delivery rows | Peer routed |
| --- | --- | --- | --- |
| salon created | 1 | 2 | no |
| granted, peer opens it | **2** (2 455 ms) | 3 | **yes** |
| revoked | 2 (rows dropped in 2 002 ms) | 2 | no |
| the owner reloads the salon | **3** | 2 | no |
| **re-granted, peer opens it again** | **3, unchanged after 180 s** | **2** | **NO** |

The peer is entitled, the panel lists them, `PATCH /api/channels/:id/access` answers 200 - and they
receive nothing from that salon, permanently. Every message minted afterwards renders on their
screen as `no seed for session … (repairable)` and the repair cannot succeed, because a seed is
fanned out along `dm_device_group_memberships` and they have no row on it.

**The cause is an ordering, and then a stale belief built on it.** A revoke has two halves.
`evictFromDistributionGroup` (chat-delivery) deletes the leaver's membership rows, their queued
frames and their Redis routes **immediately**; the MLS half - removing their LEAF from the tree - is
committed later by a REMAINING member, when that member next loads the salon
(`rosterReconcile`). So the commit that says "you are out" is published to a group the leaver is
already unrouted from, and **the leaver never receives it**: their client keeps a live local MLS
group for a group it is no longer in. `ensureDistributionGroupFor` then reads exactly that stale
belief as its early return -

```ts
const known = mlsService.distributionGroupFor(scope);
if (known && mlsService.getLocalGroups().includes(known)) { … return true; }
```

- so on the re-grant it reconciles, asks for history, and **never re-joins**. The join is the only
thing that writes the delivery rows back. Confirmed in the peer's own console: on the second open it
logs `salon 4407ec7c … agrees with its roster - 3 leaf/leaves, nobody to remove` and posts no
`group-info` at all, while the server holds 2 rows and epoch 3.

**A local group list is not evidence of membership** - it is this device's memory of having joined,
and the authority is the server's delivery roster. The fix must carry that fact to where the
decision is made rather than let the client infer it, and it must be a durable diff and not an
event: `channel.member.removed` reaches only the devices online when it fires, which is why the
departure mechanism was built as a diff in the first place.

**What the fix measured, on the same stranded salon** (`19a58034`, group `b0192801`, left unrouted
for 53 minutes by the first attempt), the moment the second one deployed and the peer reloaded:

| UTC | Server line |
| --- | --- |
| 02:49:04 | `served channel=19a58034 user=b78568a3 … devices=0` - the group holds no row for it |
| 02:49:05 | the same read again, from the join's own transport |
| 02:49:05 | `published channel=19a58034 user=b78568a3 epoch=2 stored=true` - **it re-joined** |
| 02:49:25 | `served … devices=1` - the row is back |

Against the same salon one deploy earlier: one read, no publish, `devices=0` for three minutes. The
negative control is the first attempt itself.

Related and NOT yet measured: the same shape at COMMUNITY level (COMM-12 passed on 2026-08-20, so
either that path differs or the check did not reach this state), and whether a device that was
merely OFFLINE across a legitimate removal ends up in the same stale state. Both are cheap now that
`devices=N` is on every `served` line.

### CLOSED 2026-08-20 - a private salon now has its own distribution group

Shipped, with the user's decisions of 2026-08-19 in it: an admin JOINS explicitly (member list only,
no system message), an unjoined private salon stays VISIBLE to an admin so the join is reachable,
and forward secrecy is decided AGAINST - the reasoning on the last one is not to be re-opened
(Graine retains seeds so a joiner reads the past, channel messages are not persisted locally, so a
forgotten seed would cost a member their OWN scrollback; the exposure is bounded by the retention
window of §8 plus `history_visibility: joined`).

The design, the lifecycle table, the client changes and the one defect found while writing it up (a
discriminator `mlsDeliveryApi` dropped in transit) are on
[graine §13](protocols/channel-encryption.md#13-one-distribution-group-per-private-salon---shipped-2026-08-20),
which is the only copy. Production held ZERO private salons when it was measured on 2026-08-19, so
no backfill was written and the migration question is moot.

---

## Messaging convergence

### P3 - a `history_bundle` restores the EDITED flag without the edited body

Found by enumerating every applier of a message mutation on 2026-08-22, after three defects in that
seam were fixed (see `CHANGELOG.md` and [chat](frontend/modules/chat.md)). This is the fourth
applier, and unlike the other three it is not broken - it is deliberately narrower than the others in
a way that has a visible consequence nobody has decided about.

`systemMessageHandler.ts`, the `history_bundle` merge over messages a device ALREADY holds: a
deletion in the bundle replaces the body with the tombstone, and an edit in the bundle sets
`isEdited: true` and fills `editedAt` when absent - but never touches `content`. So a device that
missed an `edit_message` frame and later receives a bundle carrying the edited message ends up
showing the PRE-EDIT text with an "edited" marker on it. It cannot diverge two bodies, because it
never writes a body; it can present a body it knows is superseded.

**Why it is not simply a bug to fix.** Taking the bundle's body means trusting a peer's copy of
another member's message content over our own, and the comment on the deletion branch (D5) shows the
narrowness there was reasoned rather than accidental. `editSupersedes` now gives the merge a rule it
did not have when it was written - apply the bundle's body when its `editedAt` is strictly newer -
which would close this without trusting anything undated. That is a trust-model decision, so it is
recorded here rather than taken while a campaign is running.

**What would tell us it matters:** no board row covers it, and reaching it needs a device that missed
an edit AND is later handed a bundle containing it - which is the FWD/HEAL shape, not MUT's.

### P2 - a reconnected old client restored only SOME conversations, and a locally-pending deletion blocked the new conversation with that peer

Reported by the user 2026-08-23, verbatim: *"sur un vieux PC client qui avait toujours une memoire
locale (pourquoi, puisqu'il avait ete des appareils connectes via l'interface ?), le fait de se
reconnecter n'a pas charge toutes les conversations (certaines oui, certaines non). Pire : une
conversation 1v1 avec quelqu'un [qui] avait ete en attente de suppression locale sur cet appareil (le
pair avait supprime la conversation, mais nous elle etait toujours presente localement) a fait
barrage a la reception de la nouvelle conversation avec ce pair (ca faisait doublon j'imagine)."*

Three separate things, in the order they have to be answered:

1. **QUESTION first: a device removed through the connected-devices UI still held its local store.**
   Before anything is called a defect, settle what revocation is DEFINED to do - if it only stops the
   device being routed to, then local data surviving is correct and the UI's wording is the problem;
   if it is meant to be a wipe, the wipe never ran and that is a P1, not a P2. The answer decides the
   severity of this whole entry.
2. **A partial restore is worse than no restore.** Reconnecting brought back some conversations and
   not others, with nothing saying which or why. A restore that silently stops halfway looks
   complete, so the user does not know to retry - it needs to know its own expected count and report
   the shortfall, per the standing rule that a correct mechanism with no report is found by hand a
   day late.
3. **A local tombstone was treated as a live conversation for de-duplication.** The peer had deleted
   the 1v1; locally it sat pending deletion; the NEW conversation with that same peer was then
   dropped, apparently as a duplicate of the record that was on its way out. Whatever key the dedup
   uses must exclude anything pending deletion, or the pending state has to be resolved before the
   new conversation is accepted - a record that exists only to be removed must not be able to refuse
   its own replacement.

**This is HEAL's, by the user's own framing** (*"On y reviendra au moment ou on fera la campagne
HEAL"*). Rung 16 is where it gets armed: items 2 and 3 are both reproducible without a second human
- a stale profile plus a peer-side delete is exactly what the HEAL runners already build - and each
becomes a row on [cross-client-testing](cross-client-testing.md) rather than a hand-checked story.
Item 1 needs no run at all, only the definition.

## Mentions

### P2 - a mention notification shows a 64-character hex id where the name should be

Found by the user on the phone, 2026-08-22, while the MENTION rung was running.

The wire format of a mention is `@[<64 lowercase hex>]` (`utils/mentions.ts`), and the WEB resolves
it at render time - `mentions.parse.ts:44` replaces `@[id]` with `@DisplayName` for bodies, previews
and reply quotes. **The Android notification does not.** `CanariFirebaseMessagingService` READS the
token (line 1332, `decrypted?.text?.contains("@[$myUserId]")`) to decide whether this is a mention of
me, and then passes the decrypted text to the notification builder unchanged. Both paths are
affected: the MLS/DM one and `handleChannelMessage`.

So the notification reads `Salut @[d82cd226…64 hex…] tu peux regarder ?`.

**It is worse than cosmetic.** `canari_mentions` is `IMPORTANCE_HIGH` and asks to bypass DND
(`CanariApplication.kt:223`): the one notification designed to interrupt someone is the one that
cannot be read. And the check that covers the path does not see it - MENTION-2 asserts that the
notification carries the marker, which is true of a body full of hex.

**THE NAME CANNOT COME FROM THE SERVER'S PUSH PAYLOAD, and that is the whole difficulty.** The
mentioned ids already ride in cleartext for routing (the documented leak, MENTION-6), but a display
NAME is not an opaque id: putting it in the payload sends real names of real students through FCM and
APNs on every mention. This codebase already refused that trade once - the reaction push used to
carry 80 characters of decrypted message text, composed server-side, and was cut back to an id, an
emoji and who reacted, for exactly this reason.

**So the resolution belongs on the device, and it has the shape to do it.** `fetchAvatar(userId)`
already resolves a stranger's avatar from `GET /api/mls/push/avatar/:targetUserId`, authenticated by
`requesterId` + `deviceId` + the Keystore push secret, behind a 24 h file cache. A display name wants
the same three things:

- a sibling endpoint on `push.controller.ts` (there is none today - the routes are listed at
  `mls/push/{register,fetch-proto,avatar,media,refresh-token,…}`), returning `resolveUserDisplayName`
  from `utils/display-name.ts`;
- `fetchDisplayName(userId)` in the service, mirroring `fetchAvatar`'s cache-then-HTTP shape;
- a substitution pass over the body before the notification is built.

**The degrade must be decided, not defaulted.** A cache miss with no network - the exact case a
notification arrives in - must not print hex. Replacing the token with a generic word loses who was
mentioned; keeping the id keeps it unreadable. Not decided here.

**iOS is presumed to have the same gap and cannot be checked** - no iPhone in the estate
(`device-verification.md`). `push-payload.ts` builds the APNs half from the same fields.

**Cost, stated because it is why this is not a drive-by fix:** it crosses the server (a new
authenticated route, deployed) and the native app (Kotlin, plus an APK rebuild and install), and the
rebuild re-bases A1's build for every phase of the ladder that follows it.

## The harness itself

### P3 - a build names itself by a clock, and the commit is inferred from it

`/_app/version.json` carries `Date.now()` at build time and nothing else, so `resolveStamp` derives
the commit by asking git for the newest one at or before that instant. Rule 35 fixed the half that
was outright wrong - a locally built bundle was being dated against `origin/main`, a ref that does
not contain it until somebody pushes - but the derivation itself remains an inference, and it moves
if a commit ever lands carrying an earlier date than the build that preceded it (a pull of somebody
else's work, a rebase).

**The fix is the bundle carrying its own commit**: SvelteKit takes `kit.version.name` in
`svelte.config.js` and writes it verbatim into `version.json`. Setting it to `<builtAtMs>-<sha>`
keeps the timestamp the `updated` store needs to distinguish two builds of the SAME commit, and adds
the identity the harness currently guesses. `resolveStamp` then parses instead of querying git, and
the `ref` argument disappears with it.

Two constraints, both established 2026-08-22 rather than assumed:

- **The Docker image does not build the frontend.** `infrastructure/local/Dockerfile.frontend` copies
  `frontend/build/client` from an artifact the CI `build-frontend` job produced, so git availability
  is a question about the CI job and the local Tauri build, not about the image. Both have a
  checkout.
- **It changes the deployment's version identity**, which is why it was not done during the campaign:
  prod IS the test server, and a `svelte.config.js` that throws when git is absent breaks every
  build including CD. Verify the CI job's checkout depth before relying on `git rev-parse`.

### P3 - six runners carry a dead import, and fixing them now would retire green rows

`oxlint tools/cross-client-harness/` reports eight warnings across `newgroup.mjs`, `msg9.mjs`,
`ckpt.mjs`, `type.mjs`, `tabguard-selftest.mjs` and `ws1.mjs` - unused imports and one useless
spread, nothing that changes what any of them measures.

**Deliberately not fixed during the campaign.** `msg9.mjs` and `type.mjs` back MSG and TYPE, both
green on the board, and `checkSha` hashes the runner's source: touching either supersedes its rows
(`rows.mjs`), so the ledger would demand a re-run of two finished phases to pay for a dead import.
Rule 33 is what makes that automatic, and it is right to be - the ledger cannot know the edit was
cosmetic, and a human waving it through is exactly the judgement the rule exists to remove.

Sweep all eight in ONE commit once the ladder is finished, when a re-run costs nothing. Note the
harness is NOT oxfmt-formatted (`oxfmt --check` fails on files nobody has touched), so the sweep is
`oxlint` only - running the formatter would rewrite the whole directory.

### P3 - the bubble-action and observation helpers live in one runner, and every other runner re-invents them

`mut.mjs` carries `clickBubbleIcon` / `deleteBubble`, which locate a message's controls by their
lucide icon class and prove the click was RECEIVED - its own header calls this "a pattern the rest of
the harness could adopt". `search.mjs` did not adopt it and hand-rolled a confirm click that pressed
the wrong button for as long as the check has existed (2026-08-22, see `CHANGELOG.md`). The same
split exists for observation: `longestSilence` turns a hole in a client's timeline into a value, MUT's
`finish()` attaches it to every non-PASS verdict, and no other phase does - which is exactly the
evidence rung 5's one SEARCH-2 miss needed and did not have.

**Why it is not done yet, and this is the whole reason it is written down.** The shared home is
`chat.mjs`, and every phase consults `chat.mjs`. Moving a helper there invalidates MSG, TYPE, READ and
MUT under [testing-methodology](testing-methodology.md) 33 - "a board row whose phase was touched
anywhere gets re-run rather than reasoned about" - which is hours of ladder time to buy a refactor
nothing is currently failing for. So it waits for a moment when the rig can be changed wholesale and
the affected phases re-run together, rather than being slipped in mid-ladder where it would silently
cost four phases their verdicts.

## Search

### P3 - `ChatArea.svelte` swallows three branches and has no logger at all

Found on 2026-08-22 while verifying the SEARCH-2 gap description against source, before rung 5 ran.
The component is 1206 lines, carries the whole in-conversation search UI, and contains **no logging
of any kind** - no `Log.d`, no `appendLog`, nothing. It also has three branches that discard a
failure silently:

- `refreshSearchMatches`, `catch { ids = null; }` - the full-history search failing is indistinguishable
  from a channel having no local persistence, and both land on the same `searchLimitedToLoaded = isChannel`.
  This is the branch SEARCH-2 exercises.
- `onRequestOlderFromPeers().catch(() => 'unavailable')` - a peer scrollback request failing is
  reported to the UI as "unavailable" and to nobody else.

A third, `searchableText`'s `catch { return message.content; }`, is listed here only to be dismissed:
`parseEnvelope` throwing is the ordinary case for a plain-text message, so logging it would be noise
on every search over normal history. It is named so the next reader does not re-open it.

The standing rule is that every swallowed branch logs, because in a best-effort path that is all a
loss leaves. None of these do, so a user reporting "search found nothing" leaves no trace anywhere
that says whether the query ran, threw, or ran against a truncated corpus.

**Deliberately not fixed before the phase ran.** SEARCH-2 drives the first of these branches, and a
check is worth more against the code as it shipped than against code changed the hour before to make
it look better. The fix is also not one line: it needs a logger introduced into a component that has
none, which is a change worth making once and reviewing, not slipped in mid-campaign.

**Related, and NOT the same item:** in-conversation search folds case but not diacritics, in all
three places that match (`useConversations.svelte.ts:438,480` for which messages match,
`messageDisplay.ts:218 splitWithHighlight` for the highlight, `ChatArea.svelte:622` for the query).
On a French corpus "reunion" cannot find "reunion" spelled with an accent. SEARCH-5 predicts exactly
this and PASSES when it holds, so it is a FINDING the board records rather than a check failure - see
the SEARCH section of [cross-client-testing](cross-client-testing.md).

### P2 - the posts search escapes the feed's filters, and scans the whole base before it answers anything

Reported by the user 2026-08-23, verbatim: *"La recherche dans les posts permet d'acceder a des posts
apres notre arrivee a l'EMSE (la recherche desactive les filtres ?)"*. Three distinct things, and
they are not the same severity.

1. **The filters appear not to apply to the search.** The feed is scoped, the search is not, so the
   search surfaces posts the scoped feed would never show. **The first task is to establish what that
   scope IS**, because it decides everything: a scope that is a VISIBILITY rule makes this a P1
   (search reads what the reader may not read), a scope that is only a convenience narrowing makes it
   a P2 surprise. Do not write code before that question has an answer - `## Open questions` is where
   an unanswered one belongs, and this entry moves there rather than growing a fix if the answer is
   not immediate.
2. **The order is backwards: filter, THEN search.** Filtering downstream means the search spends its
   whole cost on rows that were never going to be displayed. Correctness aside, it is the same work
   done against a corpus several times larger than the reachable one.
3. **It loads everything before it answers.** A post from this week should not wait on a scan of the
   entire base. The search should walk backwards in time and stream what it finds, so a recent hit is
   returned early and the long tail keeps arriving - the standing requirement is that the mechanism
   works for a corpus of ANY size, and a single up-front load is the shape that cannot.

Related but NOT the same item: in-conversation (chat) search is the entry above; this one is the
social feed. MiGallery's `fuzzyScore`/`fuzzySearch` is the reference implementation the standing
search requirement points at.

## Composer and reactions

### P2 - the emoji picker cannot be scrolled, and often opens outside the screen

Reported by the user 2026-08-23. Two defects and two questions, and they are listed apart because
only the first two are known to be wrong.

- **The list does not scroll.** Whatever does not fit in the panel is unreachable, so the picker
  offers exactly one screenful of the set it claims to offer.
- **The panel frequently renders partly off-screen.** So this is not only a scroll bug: the placement
  has no viewport clamping, and near an edge the picker loses rows in a second, independent way.
- **ANSWERED 2026-08-23, NO: the glyph set is the platform's.**
  `frontend/src/lib/components/messages/MessageEmojiPicker.svelte` mounts `emoji-picker-element`,
  which renders native codepoints in the system font - there is no bundled sprite sheet. Only the
  DATA is self-hosted (`data-source="/emoji-data-fr.json"`, and that exists so French search keywords
  work: `locale="fr"` alone translates the UI and not the keywords). So one codepoint, N pictures -
  Windows, Android and iOS each draw their own, and the library even ships an
  `emojiUnsupportedMessage` for a client with no colour emoji at all. **The product decision this
  bullet said was owed was TAKEN on 2026-08-23: we bundle one set - see the entry below, which is
  one work package with this one.**
- **ANSWERED 2026-08-23, YES: recents exist** - `canari_recent_emojis` in `localStorage`, most-recent
  first, capped at 12, rendered as a row above the picker. Two limits worth knowing before anyone
  "adds" the feature: it is PER DEVICE and never synced, and it is fed only by
  `handleEmojiClick`, so a reaction added by any path that does not go through this picker never
  reaches the list.

**The likely cause of BOTH defects is one line, and it is the same line.** The panel is
`flex flex-col overflow-hidden` with a `max-height` written by `bindFixedPopover`
(`frontend/src/lib/actions/fixedPopover.ts`), and the `<emoji-picker>` inside it already carries
`min-h-0 flex-1` - which is exactly the arrangement that sizes correctly on its own. It is then
overridden by an inline
`style="height: min(22rem, calc(var(--popover-max-h) - {recents ? '5.5rem' : '3rem'}))"`. That
subtraction is a HARD-CODED GUESS at the height of everything above the picker, and the recents row
is `flex-wrap` with up to twelve 32 px buttons plus a label inside a `min(92vw,22rem)` panel - so it
wraps to two lines well before twelve, and the guess is then short by a whole line. The picker is
sized taller than the room actually left, the parent is `overflow-hidden`, and the bottom of the list
- with its scroll affordance - is clipped away. **The fix is to delete the inline height, not to
correct the constant**: the flex layout already knows the answer, and a second hard-coded number
would be wrong again the next time the header gains a line (the reactions-at-limit banner is exactly
such a line, and it is not in the guess either).

A second, narrower placement fault is in `computeFixedPopoverPosition`: `maxHeight` is floored at
`Math.max(160, ...)` after the side has been chosen, so on a short viewport the panel can be given
160 px in a gap smaller than 160 px and hang off the bottom. The floor should not be able to exceed
the space that was measured.

Both defects are visible without any instrument, so this needs no campaign row to be believed - but
the picker sits on the reaction path that DEL, MUT and MSG all drive, so fixing it mid-ladder changes
code under checks that have already run. Schedule it after the ladder unless the user says otherwise.

### P2 - the app draws emoji with the platform's font, and must draw ONE bundled font everywhere (decided 2026-08-23)

**Decided by the user on 2026-08-23, and the weight is explicitly NOT a factor** (their words: the
size does not enter the decision). Canari bundles **Noto Color Emoji** and draws every emoji with it,
in the whole app and the whole site, on every platform. This is the product choice the third bullet of
the picker entry above said was owed.

**It is ONE work package with the picker fixes, not two** - the user's framing, and it is structurally
right: the picker is where the set is OFFERED and the app is where it is DRAWN, so offering what the
font cannot draw, or drawing what the picker never offers, is a single defect seen from two ends. The
picker's scroll and placement faults are described in the entry above and are not restated here.

Microsoft's Fluent Emoji was examined first, on 2026-08-23, and **rejected on coverage, not licence**.
It is MIT (copyright Microsoft Corporation, no trademark clause in the repository), so it would have
been legally clean. Measured on its git tree: 1 595 base emoji, 3 145 variants, **zero country flags**
(the only "flag" assets are Black, White, Chequered, Triangular, Crossed, Pirate, Rainbow,
Transgender and Flag-in-hole), **no family / couple / people-holding-hands ZWJ sequences** at all, and
frozen at Unicode 15.1 (its Emoji 15.1 merge is from 2024-10-02, its last commit 2025-01-30). It also
ships no font whatsoever - 12 625 files: 3D PNG 109.7 MB, Color SVG 131.9 MB, Flat SVG 17.2 MB, High
Contrast 6.4 MB. A set with no flags cannot be THE set for a French student association.

#### Why Noto, in numbers

`googlefonts/noto-emoji`, OFL 1.1, last push 2025-09-15. Measured on its git tree 2026-08-23:

- `svg/` holds **3 732 glyph sources**, of which **2 291 are multi-codepoint sequences** (ZWJ
  families, couples, professions, skin tones). Country flags live in `third_party/region-flags`, and
  the prebuilt fonts prove they are shipped: `Noto-COLRv1.ttf` 4.7 MB **with** flags against
  `Noto-COLRv1-noflags.ttf` 2.8 MB, plus a `NotoColorEmoji-flagsonly.ttf` of 0.8 MB.
- **It is level with the picker's own dataset.** Probed by codepoint: every Emoji 16 addition
  (fingerprint, leafless tree, root vegetable, splatter, harp, shovel) and every Emoji 17 sample
  taken (distorted face, orca, trombone, treasure chest) is present. That is what makes "the picker
  offers exactly what the app can draw" an achievable requirement rather than an aspiration.
- **Licence.** OFL 1.1 permits embedding in the APK/AAB/IPA/AppImage and permits modification
  (subsetting, rebuilding). The header declares `Copyright 2013 Google LLC` with **no Reserved Font
  Name**, so a rebuild does not force a rename. Two real obligations: the OFL text travels with the
  binary, and the font is never sold on its own. One notch more verbose than MIT, no practical effect
  here, and compatible with a public repository.

#### The format is the whole difficulty, and it has a solution

No single colour-font table covers both engine families, and Canari ships on both:

| Table | Chromium: WebView2 (Windows), Android WebView, Chrome/Edge | WebKit: WKWebView (iOS, macOS), Safari | Firefox |
| --- | --- | --- | --- |
| **COLRv1** | yes, 98+ | **no** - not implemented, and marked not in active development (WebKit standards-positions 415) | yes, 107+ |
| **OT-SVG** (`SVG` table) | **no**, ever | yes - Safari 12.1+, iOS Safari 12.2+ | yes, 31+ |

The two are exactly complementary, and **they fit in one file**. `maximum_color`, from
`googlefonts/nanoemoji` (Google's own tool, the one that builds Noto), adds the `SVG` table to a COLR
font and the reverse; its stated intent is "a font that will Just Work in any modern browser". Each
engine reads the table it understands, from a single `.woff2`. Where a two-file split is preferred
instead, the selector is `src: url(...) tech(color-COLRv1), url(...) tech(color-svg)`, with
`@supports font-tech()` available since Safari 17 for the awkward case.

Three things that must not be got wrong:

- **Do not pass `--bitmaps`.** Chrome and anything on Skia *prefers* CBDT to COLR when both tables are
  present (nanoemoji says so, over Skia 12945 and FreeType 1142), and CBDT is the 10.1 MB build.
  Weight is not a factor by the user's decision, but rendering the WRONG table is a defect.
- **nanoemoji describes itself as "under active development, doubtless full of bugs".** So it is not a
  CI dependency: build ONCE, commit the produced `.woff2`, and record the exact command plus the
  expected hash so the artefact is reproducible without the toolchain being installed anywhere. This
  is the opposite disposition to `frontend/src/lib/wasm/`, which is generated and not committed
  precisely because every pipeline can build it; nothing in CI can build this one.
- **Serve it from our own origin**, never Google Fonts: a third-party font host leaks the IP of every
  member and cannot work offline in the Tauri apps.

**WebKitGTK (the AppImage) is the one target that may read neither table** - it goes through
FreeType/Skia and WebKit bug 191976 ("[FreeType] Color emoji not properly supported") is still open.
It is also the only target where the failure is free: the system emoji font on Linux **is** Noto
Color Emoji, so the fallback draws the same pictures. Verify it once on a real AppImage; do not design
around it.

**And note what this is, under the standing rule that a fallback is a signal and never a path**: a
font stack IS a fallback chain, so "it looks right" is not a verdict. The question is always *which
family resolved*, and that is measurable - see the campaign rows below.

#### What has to change in the app

- **The two global stacks are the whole of it, and neither has an emoji fallback today**, which is why
  100 % of emoji are currently the platform's: `frontend/src/app.css:134` (`body`) and
  `frontend/src/app.css:144` (`h1`-`h6`, `.font-brand`). Append the bundled family to both.
- **The picker uses the same family or the app disagrees with itself.** `emoji-picker-element` 1.29.1
  exposes `--emoji-font-family` on the element; that is the entire change on that side.
- **Every stack that is re-declared for an EXPORT is a place the screen and the artefact can
  disagree**, and each one must be handled explicitly: `PosterCanvas.svelte` (4 inline stacks),
  `calendarExport.ts`, `trombinoscope.ts`, `avatar.ts` (an SVG data-URI stack), and
  `MentionComposerInput.svelte:399` (monospace).
- **A PDF is not a browser.** `frontend/src/lib/pdf/appFonts.ts` maps a computed stack plus a weight
  onto an embedded jsPDF font, so an emoji in an exported PDF is a separate question this WP owes an
  answer to (embed, or rasterise). The CSS change does not cover it.
- `font-display: swap` plus a preload, and the font shipped as a bundled app asset so the mobile
  builds have it at first paint with no network. An invisible emoji while a font loads is worse than a
  platform emoji.

#### The picker must offer exactly what the font can draw

- **What it offers today**: `frontend/static/emoji-data-fr.json`, 540 KB, emojibase FR, **1 923 base
  entries / 3 953 including skins**, groups 0-9 all populated (270 flags, the France flag present,
  249 ZWJ entries), with `version` values up to **Emoji 17**.
- So the offered set and Noto are level, and the WP owes a **build-time diff that proves it**: every
  codepoint and every sequence in the dataset must resolve to a glyph in the shipped font (`cmap`
  plus the `GSUB` ligatures that make a flag or a ZWJ family one glyph). It belongs in the build
  recipe, not in a one-off notebook. A miss is then either a font to rebuild or an entry to drop -
  either way a known fact, not a surprise on a member's screen.
- **DEFECT FOUND WHILE SCOPING THIS, and it is the "offers everything" half.**
  `MessageEmojiPicker.svelte:256` reads
  `data-source={getLocale() === 'en' ? undefined : '/emoji-data-fr.json'}`, and `undefined` means the
  element's default, which is
  `https://cdn.jsdelivr.net/npm/emoji-picker-element-data@^1/en/emojibase/data.json`
  (`picker.js:1649`). So on the English locale the app fetches its emoji data from a third-party CDN -
  an outbound request, hence an IP leak, for every user who opens the picker; the picker cannot open
  offline, which is fatal in the mobile apps; and `@^1` pins nothing, so the offered set changes under
  us, which is exactly the non-determinism the standing directive forbids. **Self-host the EN dataset
  the way FR already is, and pin both.**
- `emojiUnsupportedMessage` is shown by the library when it detects no colour-emoji support at all.
  Once a font is bundled, decide whether that state is still reachable (WebKitGTK is the only
  candidate) and delete the string if it is not - a message nothing can display is noise in
  `messages/*.json`.

#### What a future campaign owes - asked for by the user on 2026-08-23

These are rows for the **second campaign** (see that entry below); they are listed here, once, and are
not restated there. Every one names the evidence it rests on, because "the emoji looked fine" is not
an observation.

1. **The bundled family actually resolved**, per platform, on W1, W2 and A1 - plus an iPhone when one
   exists. `document.fonts.check()` is necessary and not sufficient: it answers "loaded", not "used".
   The verdict rests on a rendered-pixel comparison of one known codepoint against the same codepoint
   with the platform family forced. **Identical pixels mean the bundled font did NOT apply.**
2. **The same codepoint is the same picture on every device.** One message carrying a v1 emoji, a
   country flag, a ZWJ family, a skin-toned person, an Emoji 16 and an Emoji 17 addition; compare the
   rendered bubble across W1, W2 and A1. Cross-device identity IS the point of this WP, so this is the
   row that fails if the font silently did not load on one client.
3. **A flag and a ZWJ sequence render as ONE glyph**, not as two letters or five people. This is the
   row Fluent would have failed outright, and a font built without its `GSUB` fails it too.
4. **The whole set is reachable in the picker**: scroll to the last row of the last group, on a short
   viewport, with the recents row both empty and full - the two states whose heights differ, which is
   the arrangement the picker entry above traces the clipping to.
5. **The panel is entirely inside the viewport** at each anchor: first message, last message, a row at
   the top edge, one at the bottom, on the own side and the peer side.
6. **French search still finds things** (the FR dataset is load-bearing for keywords) **and English
   search works with the network off** - the row that would have caught the jsdelivr default.
7. **Pick, send, peer**: the codepoint the peer receives equals the one picked, and it is still a
   CODEPOINT - copy the text out and assert on it. That is the proof the app stayed on the font path
   and did not drift into image substitution.
8. **A reaction** carrying a flag and a ZWJ sequence survives the round trip, including the
   distinct-reaction limit path.
9. **The notification shade is drawn by the OS**, so an emoji in a notification body uses the SYSTEM
   font and will not match the app. Assert what it does; do not assert that it matches.
10. **Exported artefacts**: an emoji in a poster, a calendar and a trombinoscope export. Whatever this
    WP decides for PDF, the campaign asserts it.
11. **Cold start, offline, on A1**: open the picker with no network and confirm the set is complete AND
    that no request left the device - an assertion about the absence of an outbound request, which the
    harness's server window can support.

#### Limits to state before anyone reports them as bugs

- **The notification shade, the OS share sheet, the keyboard's own emoji panel and every other native
  surface are drawn by the platform.** Bundling a font changes nothing there. "The notification shows
  a different emoji" is then expected behaviour, not a regression.
- A member on an Android WebView older than Chrome 98 gets neither table and falls back to the system
  emoji font - which on Android is Noto anyway, so the picture is unchanged. `minClientVersion` is not
  the lever for this.


## Storage and retention

The server side has a page already - [storage-forecast](infrastructure/storage-forecast.md) - and it
is where any measurement belongs.

### Server - can occupancy be monitored, and will it hold?

**The media half shipped 2026-08-18** and is documented on
[storage-forecast](infrastructure/storage-forecast.md): `/admin/storage` now separates growth (bytes
written per 7-day window) from a retention sweep that has stopped taking anything, and counts
separately the objects no sweep can EVER reach. That last one was not hypothetical -
`purgeExpiredMedia` iterates the metadata index, so an object with no entry is invisible to it for
ever, and 7 such objects (~11 MB) were already measured.

**The MLS half shipped 2026-08-19**, and this entry is closed. Postgres and Redis are no longer bare
totals: the panel lists the eight MLS tables by size with their row counts, reports the queue as four
figures (total, devices, oldest, and the DEEPEST single device queue - the one a total cannot show),
counts §5.7's WP-GHOST-1 shape continuously, and breaks Redis down by key prefix from a bounded
sample that says how much it sampled. The production baseline and the reasoning are on
[storage-forecast](infrastructure/storage-forecast.md); do not restate them here.

**Decided 2026-08-17: the panel is the whole of it, there is NO alert.** The user's call. Worth
stating what that costs rather than pretending it costs nothing - the standing rule is that a correct
mechanism with no report is found by hand a day late, and a panel is a report only for whoever opens
it. The slope is what makes it survivable: a number read once a month against a trend is enough to see
a wall coming, where a bare total is not. **§5.7's own "more than a few hundred rows" predicate is
deliberately left unarmed**: the deepest real queue is 189, so a threshold set from the last incident
would be a threshold nobody has measured against the population it would run on.

> **Already shipped, do not re-open:** _"ne garder que les messages les plus recents (dernier mois),
> et le reste recuperable en demandant l'historique a un appareil mobile"_ is exactly the device
> window plus the scrollback range request delivered in the history-reconciliation rework - web keeps
> 90 days, mobile and desktop 5 years, and reaching the top of the scrollback asks a peer for the
> range below the window. See [history-reconciliation](protocols/history-reconciliation.md) and
> `historyWindow.ts`.

> **Already shipped, do not re-open:** _"pourquoi garder plus d'un accuse de lecture sur de vieux
> messages ? Si le dernier message a ete lu, le precedent aussi"_ is the read watermark that replaced
> per-message `readBy` in the same rework - read state is now ONE timestamp per (conversation, user),
> and `readersOf` derives the per-message display from it.

---

## Payments

### Flipping `payment_provider` from Stripe to Lydia (WP-LYDIA-1)

**The code is not the blocker - it is already written and tested.** `PaymentProvider` is an interface
(`apps/core-service/src/payment/payment-provider.interface.ts`), `LydiaPaymentProvider` implements the
two flows that map cleanly onto it (one-off checkout, session lookup) with its own signature module
and specs, and the choice is a platform config column (`payment_provider`) that **defaults to
`stripe`**. Stripe is what runs today and nothing about that is broken.

What is missing is not code, which is why this is a question and not a P-anything: the **credentials**
and the **answers Lydia owes**. Everything that does not map - live balance and status, saved payment
methods - throws a documented error rather than faking a result, and that is deliberate: Lydia has no
live status-poll endpoint, and the saved-card flow was **explicitly dropped by the user** rather than
reimplemented, so every purchase becomes its own interactive request. Do not re-litigate that.

The full provider mapping, the remaining open questions and the credentials still owed are in
[`plans/stripe-to-lydia-migration.md`](../../plans/stripe-to-lydia-migration.md), which the wiki page
[payments](frontend/modules/payments.md) already points at.

**2026-08-19: onboarding storage coexists (see [core-service#payments](services/core-service.md#payments-stripe--lydia)),
and checkout routing now does too.** `resolvePaymentTarget` (`payment-delegation.util.ts`) takes the
active provider as a parameter and resolves against the matching column pair; `AssociationsService`/
`ProductsService` fetch it from the public `GET /api/payments/provider` before resolving, and let a
failure to reach core-service propagate rather than guess. `PaymentTarget.connectAccountId` (renamed
from `stripeAccountId`) now genuinely holds whichever provider's account is active. A Lydia
`request/do` payment is also confirmed server-side now: `confirm_url`/`cancel_url`/`expire_url` are
registered per-request, and `POST /api/payments/lydia-request-callback`
(`webhook.controller.ts`) verifies the signature and fans out to the same submission/purchase
fulfillment Stripe's webhook already used, via a shared `order_ref` encoding
(`form:<submissionId>` / `product:<productId>:<userId>`, parsed by `lydia-order-ref.ts`).

**Two things still block actually flipping the switch, both found while wiring this:**
1. **`payerRecipient` is never supplied.** `LydiaPaymentProvider.createCheckoutSession` throws
   without it (`request/do` needs the payer's email/phone), and nothing in `products.service.ts`/
   `forms.service.ts` resolves one - the interface field has existed since Phase 2 but no caller was
   ever wired to it. Needs a design decision on where the payer's email comes from for a boutique
   purchase (a logged-in user's account has no email stored in social-service today; only forms with
   a guest `input.email` field have one at all).
2. **The `business/create` `BUSINESS_VALIDATED`/`BUSINESS_UNVALIDATED` webhook is deliberately not
   built.** It has no documented signature and `vendor_token` is PUBLIC - building it as-is would let
   anyone knowing another association's vendor_token forge or break its `lydiaOnboardingComplete`,
   with no resync since Lydia sends the event once. Add "does `business/create`'s `webhook` param
   have a signature scheme?" to Livrable A below before building this.

---

### MEASURED 2026-08-20 - a role change does not reach the person it is about

**COMM-5 passes and records `liveWithoutReload: false`.** The promotion itself is immediate and
correct - `member` -> `moderator` -> `admin` -> `member` on the server, each step landing before the
next was asked for, and the owner's own panel showing each one. What does not happen is the OTHER
device learning about it: the peer gained the manage controls only after a full reload, and the wait
that says so is bounded at 20 s and reported next to the answer.

**Which direction matters is the demotion, not the promotion.** A promoted moderator who cannot
moderate until they reload is an annoyance. A DEMOTED administrator goes on being offered every
control they have just lost, for as long as their tab stays open. That is not a security hole - the
server re-checks every one of them, and the components say so in their own comments ("hiding the
button is convenience, not the gate") - but it is a person clicking things that will now fail, with
no explanation on screen.

**DECIDED 2026-08-20 by the user, and SHIPPED the same day: PUSH IT.** `workspace.role.changed`
carries the new role's whole permission set to the member it concerns and to nobody else, and their
client applies `viewerCanManage` from the event - it does not refetch, because a refetch can fail,
can be declined while a load is already in flight, and would return exactly what the event already
carries. Best-effort and logged: the role is written before the announcement is attempted, so a
failed publish leaves the member where they were before any of this existed. COMM-5 is now STRICT on
`liveWithoutReload` and keeps the reload path only to separate "the push did not arrive" from "the
grant never happened".

**The invariant this rests on, written down because nothing enforces it:** `viewerCanManage` is the
only permission-derived value the client caches. The event carries the full list so that the day a
second one is cached, only the client handler changes.

### FOUND 2026-08-20 - a custom role can be created by the API and by nothing else

`POST /channels/roles` exists, `ChannelService.createRole` on the client exists, and **no component
in the application calls it**. The roles tab renders a permission grid over whichever roles the
workspace already has - the three defaults - and offers no way to add a fourth. Enumerated, not
assumed: `createRole` has exactly two non-test references in the frontend tree, its declaration and
nothing else.

**DECIDED 2026-08-20, by the user: THREE ROLES IS THE PRODUCT.** `ChannelService.createRole` is dead
client code and is deleted; COMM-6 is rewritten to ask what the grid actually does - that it offers
exactly the six enforced permissions and no seventh, and that a toggle on it is enforced.

**The server route is KEPT, and this is the reasoning rather than a shrug.** `POST /channels/roles`
is the only way a custom role can exist at all, and the grid renders whatever roles a workspace has
- so a role made through the API is visible and editable, just not creatable, and the interface
degrades into read-and-edit rather than breaking. Deleting the route would also delete the tested
service method behind it and the migration history that shaped it, for no gain: nothing calls it, so
nothing costs anything. **The one wart worth writing down:** `normalizeRoleLabelToCanonical` folds
any unrecognised role name to `member`, so a custom role shows in the member list as "Membre" while
holding whatever permissions it was given. That is a display fault waiting for the day somebody uses
the route, not today's problem.

**What is NOT in doubt** is the six: `channel.access` and `channel.send` are out of the registry, out
of the grid and out of `channel_roles.permissions` by migration, and `RETIRED_PERMISSIONS` keeps
their names only so an old client's write can be told from a wrong one.

### CLOSED 2026-08-20 - deleting a salon archived it, after destroying its key

`DELETE /channels/:channelId` set `channels.archived = true` and, in the same call, destroyed the
salon's key-distribution group. A private salon therefore ended as ciphertext nothing holds a seed
for: invisible to every listing, unreachable by every route, with no un-archive anywhere in the
service, and removable only by deleting the whole community. That is the shape `deleteWorkspace`
had rejected on 2026-08-18, one scope up, in the same words - the fix was written as a sentence
about a mechanism and applied to exactly one caller of it.

**Found by COMM-16**, whose `channelRowGone` came back false on its first run, and very nearly lost
by "fixing" the check to match the code. Now shipped: the salon, its `channel_messages` and its
group are deleted, group first and allowed to abort; both `archived` columns dropped by migration
046 (prod held zero archived rows in either); six tests in `channel-delete.spec.ts`, which the route
had none of. No confirmation argument, deliberately - reasoning on
[social-service](services/social-service.md#deleting-a-channel-took-no-new-argument-deliberately-2026-08-20).

### P3 - an admin who never joined a private salon is not told when it is deleted

`channelAudience` is the salon's roster, and since 2026-08-19 an administrator reaches a private
salon by JOINING it rather than through `workspace.manage` - so one who has not joined is not on the
roster and receives no `channel.deleted`, nor any other event the salon emits. They ARE shown that
the salon exists (name only, `viewerHasAccess: false`), so their sidebar keeps a row for something
that is gone until their next load.

**Not fixed by widening the audience**, which is the obvious move and the wrong one: that is exactly
what put every private salon's messages, typing, pins and poll tallies on the socket of members the
same server refuses to serve them over REST, and it was closed this week. The shape that would work
is a separate, contentless `channel.gone` addressed to the community - worth doing only if the stale
row is ever seen to matter, since a reload clears it and nothing is wrong underneath.

### DECISION OWED - naming the author of each line inside a salon's stacked notification

Asked for by the user on 2026-08-20: salon notifications should read like a DM's - successive
messages stacking one under another in a single banner. **The stacking already exists**;
`handleChannelMessage` goes through `showNotification`, so a salon gets the stable per-conversation
id, the `MessagingStyle` history rebuild, the badge, the clear-on-open sweep and the cross-device
dismissal. NOTIF-11 is what will say so on a current APK.

What is genuinely missing is the ATTRIBUTION. `senderName = title` and `groupName = ""`, so every
line in a salon's stack is attributed to `<Communaute> - #<salon>` and a reader cannot tell who said
what. The comment there is honest about why: the server sends only `senderId`, for the avatar.

Two shapes, and the choice is the user's:

1. **The name on the wire.** One field beside `channelName` and `workspaceName`, which already
   travel in cleartext. Cheapest, and it puts one more piece of who-talks-to-whom through Google and
   Apple - which is the exact cost the reaction push was rewritten in 2026 to stop paying.
2. **A `push/display-name/:userId` lookup, beside `push/avatar/:userId`.** The phone already
   authenticates to that route with the push secret and caches the answer for 24 h; a name would
   ride the same shape and put NOTHING new through a third party. Costs one request per unknown
   sender on a cold notification, cached thereafter.

**Recommended: (2)**, because the avatar proved the shape and it keeps the wire where it was. Not
started - it is a real work package, and NOTIF-12 records the current behaviour rather than failing
on it, so nothing here blocks the campaign.

### REPORTED 2026-08-20 - quick reply from the shade does not work, and mark-as-read is unknown

From the user, on the phone, unprompted. **The APK on that device predates the current bundle**, so
neither observation is attributable to the code as it stands - which is exactly why they are rows
(NOTIF-6, NOTIF-6b) and not fixes. `CanariNotificationActionReceiver` implements both actions and
both call `cancelConversationNotification`; device check K recorded the reply path as sending, with
K2 covering the undelivered case ([device-verification](device-verification.md)).

**Owed in this order:** rebuild the APK, install it, then run NOTIF-6 and NOTIF-6b. A failure on the
current bundle is a defect; a failure on the old one is the mixed fleet doing what it is.

## Post-campaign projects - decided, not scheduled

### The MLS + Graine explanation, written FOR THE USER - audience settled 2026-08-20

**Asked for earlier, deferred on one question: who reads it.** Three audiences were offered and the
user chose the first outright.

**Who it is for: the user.** What is guaranteed, against whom, and - as loudly - what is NOT.
Prose and diagrams. **No file names, no function names, no code**, because those are what a
maintainer needs and this is not for a maintainer. Readable end to end in one sitting, which is a
length constraint and therefore a selection constraint: everything that does not change what the
reader can conclude is cut.

**What it must contain, since the whole point is the boundary.** What the server sees (ciphertext,
sizes, timings, who talks to whom) and what it cannot see. What a community's shared key means: every
member of a community holds the key to every PUBLIC salon in it, by design, and until 2026-08-20 to
every private one too. What a private salon's own group changed, and what it did not - an admin now
JOINS and is visible in the member list; forward secrecy was decided AGAINST, deliberately, and the
document says so rather than omitting it. What leaving, being removed, and being re-invited actually
do to the keys. What a stolen device gets, and what the PIN does and does not protect.

**The two audiences declined, recorded so the choice is not re-litigated.** A maintainer's page (file
names, invariants, where each is held) would be a wiki page more, long, needing to stay synchronised
- the wiki already carries that, split across
[mls-protocol](protocols/mls-protocol.md) and [graine](protocols/channel-encryption.md). A security
assessor's document (explicit threat model, what an excluded member can do) is the most demanding of
the three and nobody has asked for one.

**Written AFTER the campaign**, because the campaign is what turns the design into something
measured, and a document that says "this is guaranteed" before anything has run is a claim about a
file rather than about a system.

### One MLS client in a SharedWorker - decided 2026-08-17

**It would remove the multi-tab class outright**, and that class is not theoretical: W2 was measured
carrying seven `canari-emse.fr` tabs, each a full MLS client with its own gateway socket and its own
in-memory counters, sharing one IndexedDB key. Two campaign findings dissolved on that fact alone
(see [testing-methodology](testing-methodology.md), rule 5), and the harness's answer - `client()`
refusing an ambiguous browser, `onetab.mjs` repairing it - protects the INSTRUMENT and not the user.

**Why it is not a queue item.** The cost is not the worker: it is the worker TRANSPORT, the startup
sequence, the PIN unlock and the Safari/mobile fallback, all of which have to be redone. Doing it
before the campaign would invalidate every verdict already taken, since the boot path is what half of
them measure.

### `dev.canari-emse.fr` becomes a real second environment - decided 2026-08-17

Today it is a proxied CNAME onto the same tunnel as production - one environment wearing two names.
The user wants trials to stop happening on prod, which is the right instinct: every reproduction is
authorised on prod only because there is nowhere else, and each one leaves debris on a shared server
that real members use.

**What has to be decided before any of it is built**, because a second environment is a second copy of
every secret and every service: whether it gets its own database or a snapshot of prod's, its own
object storage, its own push credentials (an FCM sender is per-project, so a shared one would send a
test notification to a real phone), and whether its data is ever restored from prod - which would
carry real people's ciphertext onto a machine with weaker rules. Scope that first; the tunnel and the
DNS are the easy half, and they are already in hand.

### A SECOND campaign, for everything that is not chat - asked for 2026-08-16

**It is a second campaign, not more sections on this one** - the user's framing, and it settles a
structural question. The expected size is dozens of checks per surface, where the current dashboard
already carries 18 sections in one file whose entire job is to be a LIVE summary someone can read.
Pouring a second campaign into it destroys that property. So: its own dashboard, its own manifest, its
own phase files - and `checks.mjs`'s phase list is the seam to look at first, since a second campaign
must be runnable without re-running this one.

The 18 sections were written around one class of failure: a message crossing between two transports
and two platforms, and the silent loss that class produces. That leaves whole surfaces with **no check
at all** - posts, forms, communities as a management surface, profiles, media browsing, calendar,
payments - and a surface with no check is not a surface that works, it is one nobody has asked about.

The named starting point is the **`social` notification family**: a post, a comment, a reaction on a
post, a form alert. It does **not** share the chat path - no MLS, no per-device fan-out, no outbox -
so none of the verdicts already taken transfer to it, and its delivery is server-decided, which is a
different failure mode (an audience computed wrong notifies the wrong people, and nothing on the
client can detect that).

Three things must be settled BEFORE writing checks:

- **The venue.** Every existing check sends into the two-test-account DM or `Campagne de test`
  precisely because production is shared. A post or a form alert has an AUDIENCE, so the same
  discipline needs an answer that does not exist yet: what does a test post look like that no real
  member is notified by? Until that is answered, no social check may run on prod.
- **The observer.** `srvlog.mjs` partitions its window by subject and classifies every line. The
  services behind posts and forms are not in that window today, and an unclassified window is not an
  observation.
- **What a verdict rests on.** A chat check reads the peer's DOM. A notification with an audience is
  only correct if the people who should NOT get it did not - an assertion about absence, over a
  population, needing its window sized from a measured latency rather than guessed
  ([testing-methodology](testing-methodology.md), rule 13).

**The eleven emoji rows belong to this campaign** - they are listed in the bundled-emoji-font
entry above, which is their only copy.
