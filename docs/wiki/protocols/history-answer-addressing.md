# Addressing a history answer to the device that asked - step A (2026-10-22)

**Status: step A SHIPPED (#2270, in every stable since `v1.5.0`), owed a rig reading; option B, the
answer SEALED to the asker, is built (draft pull request, [below](#sealing-the-answer-to-the-asker---option-b-2026-11-17)).** It is step A of the P1 "a new member of a
group conversation receives its whole past". The decision, step C and its numbers are in
[history-reconciliation](history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21).
The design was reviewed on 2026-10-22 (verdict REVISE, direction kept: address first, seal later).
Building it changed three of its rules, and each change is stated where the rule is, with why.

## Why answers are addressed

A history answer is an MLS application message, so every member of the conversation receives it,
whoever it is meant for. Step C filtered the inviter's PUSH for the invitee. The answers to a request
could not be filtered that way: the diff (`sendHistoryBundleForIds`) and the scrollback
(`sendHistoryRangeBundle`) answer one device, often a new device of a founding member, which is
entitled to everything since that member arrived, while another member of the same conversation
may be entitled to less. **No single filter fits every reader of a broadcast, so the answer is
addressed to the device that asked and filtered for that device alone.**

The push is addressed the same way (rule 1): `handleWelcomeRequest` also pushes to a new device of
a member of any age, and that push is filtered for its own reader like every other answer.

## The rules, as built

1. **Every history answer is addressed** - the diff, the scrollback AND the push.
   `sendBundleChunks` sends with `recipientDevices = [to]` (`addressedHistoryAnswer`), `to` being the
   asking device's `userId:deviceId`. *Changed from the review, which kept the push a broadcast -
   see above, for consistency.* **An ask that carries no `requestId` is refused where it is parsed**
   (`historyAskId`, `systemMessageHandler.ts`, D211, 2026-11-12): every build since step A mints one
   and the floor is past it, so such an ask is malformed. Nothing is stored and nothing is answered -
   the asker could not accept the answer (rule 5), and the generation it would cost is skipped by
   every other member for nothing. Every answer names its ask by TYPE (`BundleAnswer`: a `requestId`,
   or `join` on the push), so no answer to an id-less ask can be built.
   **The broadcast branch of the `history_bundle` receiver is NOT a shim and stays:** a current build
   still broadcasts the state-only frame when the windows cannot be read (`sendStateOnly(..., false)`
   in `groupActions.ts`), and the stream walk drops what falls in the reader's own windows with the
   same `dropOwnExcludedMessages`. It goes only once that sender no longer broadcasts.
2. **The answer is filtered for its ONE reader** (`readerHistorySelection`). The windows are the
   reader's own `withheld` ones (gaps plus the span before their arrival), no longer the union of
   every member's. That has a second effect: a new device of a continuous member now restores the
   messages sent while ANOTHER member was out, which the union withheld from it (the cost
   [history-reconciliation](history-reconciliation.md#a-remove-holds-against-a-later-re-add---the-answering-peer-withholds-the-window-decided-by-the-user-2026-10-14)
   quantified).
   - **When the server does not name the reader** (`?for=` is answered only for a person with a
     device added since the caller arrived), the filter is the union of every member's gaps plus the
     ANSWERER's own `withheld` windows. That is a superset of the reader's windows, by the server's
     own rule: a reader it does not name has every device row older than the caller's arrival, so
     the reader arrived first and their before-arrival span is inside the caller's; and the reader's
     gaps are in the union. It costs the reader whatever the answerer was handed before its own
     arrival, which an honest answerer does not hold anyway. An answerer the server does not count
     sends nothing.
   - **A server that predates addressed answers** (the exclusions route answers no
     `addressedAnswers: true`) gets today's broadcast: the union, plus the invitee's span on a push.
     The behaviour of step C then stands, and it accuses once per session at error
     ([legacy-compatibility](../legacy-compatibility.md)).
3. **chat-delivery accepts an addressed frame on a conversation group** where it refused one
   outright, under two conditions (`assertConversationAddressable`):
   - the frame is TRANSPORT (`durable: false`). Every history answer is, so it reaches only devices
     online now and never enters the history stream;
   - **every addressed member device declared, on its live socket, that it applies rule 5** (rule 6).
   Otherwise `400 { error: 'addressed_unsupported', devices }`. Key groups are unchanged.
   The refusal's log line names the cause PER DEVICE (2026-11-13): `offline` (no presence key - the
   usual one, a newcomer's phone when its Welcome is delivered, [backlog](../backlog.d/p2-an-offline-newcomer-receives-no-join-push.md))
   or `did-not-declare` (online, a live session without the capability). The Lua check returns `2` for
   the first and `0` for the second (`addressabilityOf`), so nothing reads Redis a second time to
   classify it; the behaviour is the same for both.
   **The inviter's join push does not learn that refusal by failing (2026-11-15).** The one addressed
   send nobody asked for is the join push that follows every delivered Welcome (`joinPush.ts`); every
   other addressed answer replies to an ask, whose asker was online to make it. On dev, one group
   creation cost nine `400 addressed_unsupported` (measured below). **Decided: the Welcome's answer carries the
   verdict** - `POST /api/mls/welcome` answers `{ status: 'queued', addressability }`, read by the SAME
   script in check-only mode (`MessagingService.welcomeAnswer`), and the join push sends nothing to a
   device answered `offline` or `undeclared` (still counted at warn, `[JOIN_PUSH] NOT DELIVERED`). Why
   this and not the two alternatives:
   - **The client holds no per-device presence or capability.** `presenceStore` polls per USER, every
     10 s, and nothing hands a client the capabilities another device declared; teaching it would be a
     second copy of a fact only chat-delivery reads (`addressing:sessions:*`), with its own staleness.
   - **A batch answer with a typed "unaddressable" outcome** would still MAKE the request, and a
     refusal of an expected case renamed is the demotion the noise rule forbids.
   - **The Welcome is a request the inviter makes anyway**, one per admitted device, already answered
     `201`, and chat-delivery is where presence and capability are known: the fact rides an answer that
     exists. No new route, no new round trip.

   **The race, and why it stays explainable.** The verdict is read when the Welcome is answered; the
   push leaves later (the pushes run one at a time, each decrypting the store). A device that DISCONNECTS
   in between is still refused at the send - the send's check is unchanged and stays the authority, the
   refusal stays a `400`, and the inviter's warn line names it (`addressable when its Welcome was
   answered, gone since`). A device that CONNECTS in between - answered `offline` (or `undeclared`) when
   its Welcome was answered, online before its turn in the one-at-a-time queue - is skipped, and
   **nothing recovers it today**: the newcomer asking for the register on its own reconciliation is
   DESIGNED BUT NOT BUILT ([backlog](../backlog.d/p2-an-offline-newcomer-receives-no-join-push.md),
   target `1.10.0`), so until it ships such a device gets no register, exactly like a newcomer offline
   at the push. A server that predates the field answers without it (`null` on the client): the push
   is sent and the send decides, as before. A verdict the server could not read is said at error there
   and left out, with the same effect.

   **What the nine `400`s were** (read 2026-11-15, `1.6.12-alpha.2` on dev, by `bun archive/notif17b.mjs`
   with a second CDP client recording `Network` on the inviting web seat - request shape and response
   body only, no ciphertext kept; the capture is rig-local). The seat minted a group and added a second
   account. **Nine `POST /api/mls/send` answered `400`, every one with the same body:
   `{"error":"addressed_unsupported","message":"the addressed device(s) did not declare addressed-history-1","devices":[<one device>]}`**;
   nothing else on `/api/mls/` answered an error.
   - **All nine were one-device addressed answers** - `silent: true`, `durable: false`,
     `recipientDevices` of exactly ONE device. Not a Welcome, not a commit (the `silent: false,
     durable: true`, no-recipients frame, answered `201` after each admission), not an application
     message (`201`). Each was followed within 100 ms by `[HISTORY_BUNDLE] <device> cannot be
     addressed ... pushing it nothing`: the sender learned the refusal from the `400`.
   - **Where they came from.** `[COMMIT] ... admits 1 device(s) at epoch 1` admitted the inviter's OWN
     second, stale web device: the first `400`. `[COMMIT] ... admits 10 device(s) at epoch 2` admitted
     the other account's ten enrolled devices: eight more, its stale rig devices. The other two of the
     ten, the phone and one live web device, were answered `201` (an empty bundle, and a one-message
     bundle).
   - **Why refused:** the refused devices are enrolled and not connected, so `offline`, not an older
     build; the body does not say which, the server's `per device:` line does.
   - **The roster of stale devices is a separate question** (a device that never signs in again stays
     enrolled), the device lifecycle; this fix only stops pushing to them.

   The same cause gave GRP-3's seven `400`s ([findings](../cross-client-harness-findings.md)).
4. **The server marks an addressed row.** `queued_message.addressed` (migration `035`, which sets a
   `lock_timeout` so it fails rather than queue every send behind a long transaction), set when the
   send was addressed ON A CONVERSATION - the flag is what rule 5 and the gateway's edge filter (rule
   6) act on, and a key-group seed answer is held to neither. The live frame carries it
   (`chat:messages`, and the gateway forwards it), and so does the pull. It never enters the shared
   history stream (already the rule).
5. **The receiver accepts an addressed frame only as the answer to its own question**
   (`historyAddressing.ts`). On a conversation, a frame delivered `addressed` is applied only if all
   of these hold; otherwise it is not rendered and not stored, it is logged at **error**
   (`[HISTORY_ADDRESSED] REFUSED`, the group, the verified sender, the content kind, the clause), and
   it is ACKed so the row does not loop:
   - **It is a `history_bundle`.** No other content may be addressed on a conversation
     (`setupMessageHandler`, before any dispatch).
   - **It is SOLICITED.** Every ask (`history_digest`, `history_pull`, `history_range`) carries a fresh
     `requestId`, kept in memory with the bound it states; the answer echoes it. The push is
     solicited by the receiver's own admission: processing a Welcome for the group records a `join`
     ask. **An ask takes at most TWO answering devices** (`MAX_ANSWERERS_PER_ASK`): the rendezvous
     elects one responder, and a re-election over a stored probe can hand the same ask to one more,
     whose answer is held to the same bound and only adds - so it is taken, not refused. Each closes
     the ask for itself with its chunk marked `last`; once both have, the ask is gone, and a third
     device is refused at error, because nothing honest produces one. *Changed twice by the #2270
     reviews: the first build consumed the ask on the FIRST answerer and dropped the second one's
     content at error; the second let any number of answerers in.* **The answerer is the device MLS
     verified**: the decrypt compares the envelope's sending device with the credential and refuses
     a disagreement (`verifiedSender`), which it can do only when the envelope names one - so an
     addressed answer naming none is refused. chat-delivery has no device in its auth context (the
     token names a user), and binds the claim the only way it can: the route requires the caller as
     sender with a device, and refuses a device that is not an active member of the group for that
     authenticated user. When a last chunk was entirely withheld, no frame
     carries `last` and the ask stays open until newer asks push it out. A page
     reloaded between its ask and the answer refuses the answer, and the comparison runs again on
     the next connection. *Changed from the review, which
     dropped open asks "at the next connection": a Welcome processed in the drain of a connection
     races that edge. The open asks are instead a bounded FIFO, 32 per conversation - state, never a
     clock, and a restarted page has asked nothing.*
   - **It is BOUNDED by the ask.** A pull's answer may carry only the ids it named, or ids inside
     the slices it named; a range answer only messages inside `[since, before)`; a digest answer
     only messages from `since` on; and every message no later than the ask plus the one-hour skew
     margin. A message outside is dropped and counted in the error line; the rest is applied.
   - **It may ADD messages and do nothing else.** A message the receiver already holds is not
     touched (no deletion, reaction, edit or tombstone merge), and the conversation's read
     watermarks, history floor and pins are not merged. The one exception is the `join` push: a
     device that was just admitted holds none of that state, and the push is how it gets the floor,
     the watermarks and the pins. A newly added message keeps the state it arrived with.
   On a key group the existing Graine rule is unchanged.
6. **The server refuses to address a device that does not apply rule 5.** *Changed from the review,
   which compared `key_package.deviceAppVersion` against a release and had a leader tab report its
   build.* The evidence is a CAPABILITY declared by the code that decrypts: the client opens its
   socket with `caps=addressed-history-1` (`gatewaySocketUrl`, the one builder both socket openers
   use). Since rule 3 makes an addressed conversation frame transport-only, its addressee is online
   by construction, and the live sessions are exactly the code that will read it.

   **The declaration is a CROSS-PROCESS fact** (`apps/chat-gateway/src/addressing.rs`). *Changed
   from the #2270 review: the first build aggregated the sessions inside one gateway process, so in a
   deploy overlap an old-build tab on one gateway and a new tab on another wrote competing presence
   values, and the device looked addressable.* Every write is one Lua script, validated before its
   first write so a failing one leaves nothing, and tested against the production Redis in CI
   (`redis_it`):
   - **one field per session** in the hash `addressing:sessions:{userId}:{deviceId}` (outside `user:*`,
     which the presence scans match), field `{process}:{connection}`, value the capability or `-`,
     written WITH its expiry in one command (`HSETEX`, the presence TTL), refreshed by its own session
     only. The expiry decides LIVENESS - how long a crashed process's field lingers - never safety:
     a lingering `-` only keeps the device unaddressable, a lingering declared field changes nothing;
   - **a retired session is recorded as LEFT** (`addressing:left:{userId}:{deviceId}`, for one TTL)
     before its field is removed. A field name is never reused, so it is the session's generation
     token: a refresh in flight when its session left writes nothing, and never resurrects it;
   - **the presence value `sessions-1`**, never written over an existing `true`. A gateway that
     predates this writes `true` and records no field, and a current one neither overwrites nor
     deletes that `true`, so it lasts exactly as long as the older gateway's session refreshes it -
     the only trace of a session whose declaration nobody can read;
   - **the presence goes with the LAST field**, asked of the shared hash inside the leave script:
     a session on another process keeps the device online, and a leave in flight cannot delete a
     presence that a later session wrote.

   chat-delivery addresses a device only when its presence value is `sessions-1` AND every field of
   its hash is the capability: ANY undeclared session of the device, on any process, refuses it. So:
   - a tab still open on an older build holds a session without the capability, and the device is
     refused while it does - no release number, no tab-reload protocol;
   - the native background paths never read an addressed frame: they skip every silent frame
     (Android `handleMlsFrame`, the iOS NSE), and nothing native drains the queue.

   **The check and the PUBLISH are one script** (`ADDRESSABLE_PUBLISH_LUA`, `addressing.ts`). The
   sender's check runs before the rows are written; the publish re-asks the same question in the
   same atomic step, so no session registered in between receives the frame. Refused there, the row
   stays queued and the refusal is logged at **error** (`ADDRESSED row NOT published`). *Added from
   the #2270 re-review.*

   **The PULL withholds it too.** The pending fetch carries the same `caps` the socket does, and a
   fetch that does not declare the capability is served no addressed row - filtered in the query,
   so the page and its cursor are untouched and the row waits for a session that can read it
   (`WITHHELD ... addressed row(s)`, info, once per change of that device's count). *Added from the #2270
   re-review: the queue pull is filtered like the realtime path.*

   **The gateway also filters at its EDGE** (`addressed_recipients`): the pub/sub loop hands an
   addressed frame only to the local sessions that declared the capability, and logs every one it
   withholds at **error** (`[PubSub] ADDRESSED frame NOT delivered`).

   The answerer then does not answer that device (`[HISTORY_BUNDLE] ... cannot be addressed`), and
   sends no broadcast in its place. The older device is served by older peers exactly as before.

## Why addressing was limited to key groups, and what rules 3-6 add

On a conversation, chat-delivery fans an application frame out to every device as ONE ciphertext,
so every member sees the same frames; that is why addressing was allowlisted to key groups. Rules 5
and 6 keep that property for everything a conversation shows: an addressed frame that is not a
solicited, bounded `history_bundle` is refused by every receiver that declares the capability, and
rule 6 addresses no receiver that does not.

## The ratchet cost of addressing

A non-recipient never sees an addressed frame, so the sender's generation moves ahead of what that
member last decrypted. OpenMLS derives forward on the next frame it does see, up to
`maximum_forward_distance` (2 000, `sender_ratchet_config` (2000, 2000)). Only CONSECUTIVE addressed
frames from one sender in one epoch count, because any frame the member does receive resets the
distance.

**One answer is not the unit; one Add is** (since #3185). The inviter's join push follows EVERY Welcome
the server stored (`joinPush.ts`), and the pushes run one after another, so one bulk Add of D devices
sends D pushes back to back, all in the epoch that Add opened, each addressed to one newcomer - and
every member, the other newcomers included, skips all of them. The distance a member must cross to
read the inviter's next frame in that epoch is the SUM, over the devices of that Add, of the frames
each push took:

- **1** frame, for every newcomer: since 2026-11-17 the push carries the conversation's state and no
  message ("What is NOT sealed", below), so a returning member no longer costs a chunk per 200
  entitled messages here. Those messages now come by the newcomer's own digest, answered by ONE
  elected responder with `ceil(entitled messages / 200)` addressed chunks plus one register frame -
  consecutive frames of THAT member, so the same sum bounds them, per ask rather than per Add.

**Nothing caps the devices of one Add** (`addMembersBulk` takes the whole list), so the bound is stated
here rather than enforced: the 2 000 is crossed by one Add of more than **2 000 devices** (about
1 000 people at two devices each), or by one answer to a returning member whose entitled store
exceeds **400 000 messages**. Past it, the members who skipped the run do not decrypt the
inviter's next frame of that epoch. A group conversation approaching either number is the moment to bound the Add in code (a cap on `inviteMembersToGroup`'s list, with
a test), not to raise `maximum_forward_distance`, whose 2 000 caps the keys a receiver derives.
Graine accepted the same bound
([channel-encryption §23](channel-encryption.md#23-a-seed-answer-goes-only-to-the-device-that-asked---fixed-2026-10-12)).
The durable rule that forbade addressing an application message is narrowed accordingly
([durable-rules](../durable-rules.md)).

## Sealing the answer to the asker - option B (2026-11-17)

**Status: BUILT for every answer that has an asker (#3775); the join push answers no ask and is not
sealed, so since 2026-11-17 it carries no message (draft pull request, below).** Addressing keeps an answer from every other member only as long as the server routes it
as told: the frame is still an MLS application message, encrypted under the group's epoch secret,
so a device the server hands it to by mistake (or on purpose) can read it. Option B removes that
trust in the server.

### The rules, as built

1. **Every ask carries its own key.** `history_digest`, `history_pull` (every frame of it) and
   `history_range` carry `answerKey`: the base64 public half of an X25519 pair minted for THAT ask
   (`mintHistoryAnswerKey`, `$lib/crypto/historySeal.ts`), inside the asker's MLS-signed frame - so
   the key is authenticated as the asking device's by the signature that authenticates the ask. The
   secret is kept beside the open ask (`noteHistoryAsk`, `historyAddressing.ts`), in memory only:
   there is nothing to store, rotate or back up, and a reloaded page, which accepts no answer anyway
   (rule 5), holds none. See "The secret's lifetime" below for what overwrites it.
2. **An engine that cannot mint a key sends no ask** (`askKeyOrNothing`, at error). An ask without a
   key would invite the unsealed answer this device asked not to receive; the next reconciliation
   asks again, nothing retries.
3. **The answerer seals the CONTENT of an ADDRESSED answer to a keyed ask** (`sealedBundleFrame`,
   `groupActions.ts`). The frame keeps in clear only what routes it - `to`, `requestId`, `last` - and
   carries the rest (the messages, and the conversation state an answer restates) as `sealed`. The
   key is checked where the ask is parsed (`parseHistoryAnswerKey`: the base64 of 32 bytes), so a
   malformed one reaches no engine and the ask reads as one from an older build. An engine that
   cannot seal answers NOTHING (at error), never the content in clear. **A keyed ask is answered
   sealed or not at all** (review of #3775): when the server says it does not address history
   answers (`getAddressedAnswersSupported` false, rule 2's legacy broadcast), the answer to a keyed
   ask is NOTHING, logged at error (`[HISTORY_SEAL] ... answering nothing rather than unsealed to
   every member`). The key proves the asker seals, so it reached a build that addresses; taking the
   server's word that it cannot would let the server switch the seal off and hand the content to
   every member. Only an ask with no key (an older asker) may still get the broadcast.
4. **The receiver opens it with the ask's secret BEFORE rule 5 takes an answerer slot**
   (`systemMessageHandler.ts`, `answerSecretOf` then `takeAddressedAsk`): bytes that do not open
   consume no slot, so a member relaying garbage cannot crowd the honest answer out of the two an ask
   accepts. Bytes that do not open are refused at error and not ingested
   (`[HISTORY_ADDRESSED] REFUSED a sealed history_bundle ... does not open under our ask (<code>)`).
   OUR engine failing (code `contract`: a rejection that is no engine code, a broken bridge) is
   said apart, as a defect of this build (`[HISTORY_SEAL] OUR engine failed to open ...`); an
   opened plaintext that is no answer content is `malformed-content`, the answerer's fault.
   A sealed answer to an ask that carried no key (the join push) and a sealed BROADCAST are refused
   the same way: nothing honest produces either. Everything rule 5 says still holds on the opened
   content - the bound of the ask, add-only.
5. **The binding (AAD)** is `canari-history-answer-v1|<group>|<requestId>|<asker>|<answerer>`,
   identities lowered (`historySealAad`, the one builder both sides call). The answerer is its user
   AND device as `digestIdentity` spells them - the identity rule 5 counts answerers by - built on
   receipt from the MLS-verified sender and `senderDeviceId`, so a device id alone (which another
   user could carry) binds nothing. So a member that relays another's sealed answer inside its own
   MLS frame, or replays it into another ask or another conversation, hands over bytes that do not
   open.

### The secret's lifetime

The secret is OVERWRITTEN (`fill(0)`), not merely dropped, whenever its ask lets it go: closed by
its last answerer, replaced by a re-noted request id, evicted as the oldest open ask, or forgotten
with every ask on a session reset (`forgetHistoryAsks`, which also re-arms the once-per-session
`[LEGACY]` notice). The receiver opens with a COPY (`answerSecretOf`), wiped when the open returns,
so closing the ask mid-open cannot pull the bytes from under it. On the engine side, `mls-core`
holds the minted secret in `Zeroizing`. On the web, the WASM `open_history_answer` takes the secret
OWNED (`open_history_answer_owned`), so its copy in linear memory is zeroized on return.

**On the phones the secret crosses the Tauri bridge as base64, and the JS half of that cannot be
wiped.** The residue, exactly (`tauriHistorySealEngine.ts`):

- **minting** returns it once as a base64 string inside the IPC response, decoded at once into the
  `Uint8Array` the ask keeps (and wipes); the response string and its JSON are not overwritable;
- **every open** builds a fresh base64 string of it (`toBase64(secret)`) and serialises it into the
  invoke's JSON payload - one more unwipeable string, and payload buffer, per answer frame received.

Those strings are garbage like any other and are collected, never overwritten: a memory dump of the
webview taken before collection can hold the secret of an ask that is still open or recently closed.
On the native side nothing is left behind: `open_history_answer` (`src-tauri`) wraps the argument
in `Zeroizing` before parsing anything, so an argument error returning early zeroizes it too, then
MOVES its buffer into `open_history_answer_with_b64_secret` (`mls-core`), which holds the string and
the decoded bytes in `Zeroizing` so neither outlives the call. **Not built: keeping the secret native
behind a handle**, which would leave no JS copy at all - it needs a native store of open asks' secrets
released by the webview's own close, eviction and forget, and released somehow when the webview
reloads without saying so (a reloaded page holds no ask, rule 5); that lifecycle is a change of its
own, weighed against a LOW finding (review of #3775, 2026-11-17).

### What members still see

The seal hides the CONTENT from a device the server misroutes the frame to. It does not hide that an
exchange took place. Every member that receives the frame, or the ask, still reads: the ask itself
(its `requestId`, its kind, its bounds - `since`, `before`, `limit` or the ids it pulls - and the
public `answerKey`), and on the answer `to`, `requestId`, `last` and the LENGTH of `sealed` (so,
roughly, how much was answered). Addressing keeps all of it from the members the server routes
correctly; nothing here hides it from one it misroutes to.

### The crypto

HPKE (RFC 9180, base mode) with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM - the HPKE half
of the ciphersuite every Canari group already uses (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`),
through the same `openmls_rust_crypto` provider. `mls-core/src/history_seal.rs` is the one
implementation: the WASM exports on the web (`wasmHistorySealEngine`), Tauri commands on the phones
(`tauriHistorySealEngine`, every value one base64 string across the bridge, sealed and opened off the
main thread). The HPKE `info` is `canari history answer v1`, which no MLS structure uses. The framing is
`0x01 || kem_output (32) || ciphertext`; every chunk encapsulates afresh, so two chunks share no key
material. No new primitive and no new dependency.

### Mixed versions

| Asker | Answerer | What happens |
| --- | --- | --- |
| seals (this build) | seals | sealed, opened |
| seals | older | the answer arrives unsealed, still addressed (step A) - **accepted**, said ONCE per session at error with `[LEGACY]` so the population is counted ([legacy-compatibility](../legacy-compatibility.md#removal-once-minclientversion-passes-the-first-stable-that-seals---an-unsealed-history-answer-2026-11-17)) |
| older | seals | the ask carries no key: answered unsealed, as before - the protocol that ask asked for |

Both [LEGACY] halves go once the floor passes the first stable carrying this: an unsealed answer to a
keyed ask is then refused, and an ask with no key is malformed and answered nothing, like an ask with
no `requestId` (D211) - planned in
[backlog](../backlog.d/p3-a-history-answer-is-sealed-or-refused-once-the-floor-seals.md).

### What is NOT sealed: the inviter's join push - so it carries no message (2026-11-17)

The push is solicited by the newcomer's own admission, not by an ask, so no key of the newcomer's
reaches the inviter: it stays addressed and unsealed. **What that left exposed to a server that
misroutes it**: a first-time newcomer was pushed only what was sent since the Add, which every member
holds; a RETURNING member was pushed what they are entitled to since their first arrival, which a
member admitted after that arrival is not. That second case was the residual, and it is closed by
taking the messages OUT of the push (draft pull request): `sendFullHistoryBundle` sends one frame
with the conversation's state (read marks, floor, pins, nickname register) and `messages: []`, and
never reads the store. The state is the conversation's, every member holds it. The messages reach the
newcomer by its own reconciliation - a keyed digest, sealed by rule 3 - which now runs at EVERY
processed Welcome (`sessionAuth.ts`, `onWelcomeProcessed`: the call was inside a branch that the
Welcome handler's own row made dead in the ordinary case, so a fresh join used to wait for the next
connection to compare). Two keys to seal the push itself were considered and rejected:

- **the KeyPackage's init key** - its secret is deleted once the Welcome is processed;
- **the newcomer's MLS leaf encryption key** - the secret is openmls's to manage (read from its
  storage by an internal type), and it rotates on the newcomer's first commit, which can land before
  the push: a key that may be gone when the answer arrives is not one an answer can be sealed to.

**Mixed versions.** A newcomer on an older build reconciles at its next connection (its
fresh-join trigger is the dead one), so from a new inviter it receives the state at once and the
messages on that connection - only a RETURNING member has any to receive, a first-time one is
entitled to what was sent since the Add. An older inviter still pushes the messages, unsealed, as
before; a new newcomer takes them (rule 5, the join ask) and asks for the rest anyway.

### The newcomer asks for its register (2026-11-17)

The push is addressed and transport-only: a newcomer whose device is not connected when its Welcome
is delivered - the usual phone in a pocket - is pushed nothing, not even the state, and nothing
retried ([backlog](../backlog.d/p2-an-offline-newcomer-receives-no-join-push.md)). So the newcomer
ASKS, on facts it holds durably:

1. **Owed from the admission.** Processing a Welcome into a conversation group (not a key group)
   writes a per-account "register owed" marker for it (`registerOwed.ts`,
   `ACCOUNT_KEY.registerOwed`, a 256-entry FIFO in `localStorage`), beside the in-memory join ask
   (`setupMessageHandler.ts`). Durable because the question outlives the page: a reload between the
   Welcome and the answer still asks.
2. **Asked by the reconciliation it already runs.** While the marker is set, `sendHistoryProbe` sends
   the DIGEST (never the state key, whose match is answered by silence) with `register: true`, and
   the ask this device keeps says `register` too (`noteHistoryAsk`). Like every ask, it carries a key.
3. **Answered first by the elected responder.** `answerHistoryDigest`, seeing `register`, sends ONE
   frame before the diff (`sendRegisterAnswer`): addressed to the asker alone, SEALED to its ask, its
   content the state and `register: true` and no message, not closing the ask (the diff's last chunk
   does). Never broadcast (a server that does not address gets no register), withheld from an
   unvouched device, nothing sent when the engine cannot seal. A register ask with no key is a defect
   of its sender: no state is sent, said at error, and the diff still goes.
4. **Taken only from what opened under the ask.** The receiver takes the state - nicknames under
   `mergeBundleNicknames`' limits (unverified, current members only), pins, floor, read marks - from
   an answer only when its ask said `register` AND the SEALED content says `register`. The flag is
   never in the clear routing: one a relaying server could set would turn an ordinary answer into one
   the reader takes state from. An unsealed frame saying `register` is taken as an ordinary answer
   and said at error. A message riding a register answer is dropped (at error): it carries the state
   only.
5. **Cleared by the first state accepted** - a register answer, or the inviter's join push.

It terminates on facts: the marker is durable, the reconciliation runs at every connection and every
processed Welcome, its deferral already waits for a member to come back, and the marker clears on the
first accepted state. An older responder ignores `register` and answers the digest as before: the
marker stays, and the next connection asks again, at the cost of a digest instead of a state key.

### What proves the register ask and the state-only push

- `registerOwed.test.ts` - the marker: durable, per account, bounded FIFO, an unreadable list reads
  as nothing owed at error, clearing what is not owed says nothing.
- `setupMessageHandler.test.ts` - a processed Welcome makes a conversation group owe its register,
  a key group none.
- `groupActions.historyProbe.test.ts` - an owed register sends the digest with `register` whatever
  the store holds, and keeps the ask with it; none once cleared; another account's marker asks nothing.
- `systemMessageHandler.lateDigest.test.ts` - the digest handler carries `register` to the answer.
- `historyDiffAnswer.register.test.ts` - the register frame leaves BEFORE the diff, sealed and bound
  to this answerer; none for an ordinary digest; a keyless register ask gets no state, at error.
- `groupActions.registerAnswer.test.ts` - one frame, addressed, its clear routing only `to`,
  `requestId`, `sealed`; its content the register and no message; never broadcast, withheld from an
  unvouched device, nothing when the engine cannot seal.
- `systemMessageHandler.nickname.test.ts` - the register is taken from a sealed register answer and
  the marker cleared; no message from it; no state from an answer to a non-register digest, nor from
  `register` said in clear (beside sealed content, or on an unsealed frame, at error); the push
  clears the marker.
- `groupActions.historyBundle.test.ts`, `groupActions.historyEntitlement.test.ts` - the push sends
  the state and no message, never reading the store, addressed or (an older server) broadcast; the
  entitlement cases it used to carry are asserted on the answer to an ask.
- **Owed on a pre-release**: reading 2 of the nicknames row with the new member's device NOT
  connected at "Ajouter" ([backlog](../backlog.d/p2-an-offline-newcomer-receives-no-join-push.md)).
  The `sessionAuth` callback that runs the fresh-join reconciliation is not drivable from a unit test
  (`buildConversationRow.onePolicy.test.ts` says why); that reading is its proof.

### What proves the seal

- `mls-core`: `history_seal.rs` - a seal opens with its secret, not with another ask's, not under
  another AAD, not after a changed byte; two seals differ; malformed inputs are typed.
- client: `historySeal.wasm.test.ts` - the TS half (AAD, content encoding, typed refusal) on the BUILT
  WASM engine: a relayed answer (another answering device), another ask, another conversation are
  refused; identities bind case-insensitively; non-sealed bytes are `malformed-sealed`.
- client: `historyAddressing.test.ts` - every ask carries a distinct key paired with the secret kept
  beside it; an engine that cannot mint sends no ask; the join ask holds no secret; the secret is
  wiped on close, replace, eviction and forget, and the copy an open holds survives them.
- client: `groupActions.historyEntitlement.test.ts` - an addressed answer to a keyed ask is sealed and
  opens to exactly what its reader may read; a keyed ask (digest, pull or range) the server would have
  answered by broadcast is answered nothing, at error; an engine that cannot seal sends nothing.
- client: `systemMessageHandler.bundleAddressing.test.ts` - a sealed answer is opened and ingested,
  still held to its ask's bound; one bound to another device, or to the same device id under another
  user, is refused; bytes that do not open take no answerer slot; our engine failing is said apart
  from bytes that do not open; a sealed join push and a sealed broadcast are refused; an unsealed
  answer to a keyed ask is ingested and said once.
- **Owed on the rig: GRP-ADDR-1**, now with the seal: A's new device logs its chunks `addressed to ...,
  sealed`, restores M1..Mn, and nothing logs a `REFUSED`.

## Decided: a quote of an earlier message

**A reply quoting a message from before a member's arrival SHOWS that member the quoted text -
decided by the user, 2026-10-22.** The quote rule stays a broadcast that reads the union of gaps
only. Extending it to every before-arrival span would blank every quote older than the newest
member, for everybody, and that cost was declined. Nothing is built for it.

## What proves it

- chat-delivery: `messaging.durability.spec.ts`, `on a conversation group` - a non-addressed device
  of the group gets no queued row and no publish; a durable or incapable addressee is refused; the
  row and the live frame carry `addressed`.
- chat-delivery: the same block - one undeclared session field, an older gateway's `true`, or no
  field at all refuses the device; the publish re-checks atomically; a key-group answer is never
  marked. `addressing.redis.spec.ts` runs the check-and-publish script against a real Redis (CI:
  `boot-nest-apps`, refused if skipped). `messaging.pending-page.spec.ts` - a fetch that does not
  declare the capability is served no addressed row. `migrations.lock-timeout.spec.ts` - 035 sets
  its `lock_timeout` before it alters the table.
- gateway: `addressing.rs` - the edge filter, the field naming; `redis_it` runs both presence
  scripts against a real Redis (CI: `test-rust`, failing rather than skipping when unset): the
  expiry, an older gateway's `true`, the presence going with the last session on any process, no
  resurrection after a leave, nothing written by a refused call, concurrent sessions.
- client: `frameDelivery.socketUrl.test.ts` - both socket openers declare the capability through
  `gatewaySocketUrl`; `mlsDeliveryApi.pending.test.ts` - so does every page of the pull;
  `historyAddressing.test.ts` - at most two answerers per ask.
- client: `historyAddressing.test.ts` (the open asks, the bounds, every ask carries an id),
  `systemMessageHandler.bundleAddressing.test.ts` (rule 5 on receipt),
  `setupMessageHandler.addressedGate.test.ts` (only a history answer may be addressed),
  `groupActions.historyEntitlement.test.ts` (rules 1-2, the legacy broadcast, an unroutable device),
  `mlsDeliveryApi.addressed.test.ts` (the typed refusal, the server flag).
- **Owed on the rig: GRP-ADDR-1** - three devices: member A's NEW device asks, newcomer C (added after
  messages M1..Mn) is online; C must log no `[HISTORY_BUNDLE] ... received` for A's answer and hold
  nothing before its arrival, while A's new device restores M1..Mn
  ([cross-client-testing](../cross-client-testing.md)).
