# Durable rules - what this codebase has cost to learn

Every line here was written after something broke. This is an **index of hard-won constraints**, not
a style guide: nothing is here because it sounded sensible, and nothing is added without an incident
behind it.

**How to use it.** Read the section matching what you are about to touch, then open the page it
points at before writing anything. The rules are deliberately blunt one-liners - they exist to make
you STOP, not to explain. The explanation is always one link away, and the link is the point: this
page is a map of where the reasoning lives, so a section you can read in twenty seconds is a section
doing its job.

**How to add one.** ONE LINE, plus the page carrying its reasoning. If the rule needs a paragraph,
the paragraph belongs on that topical page - put it there and leave the one-liner here. If it needs
no page, it probably needs no rule.

**How to remove one.** A rule dies when the thing it constrains no longer exists in the code, or
when another rule already says it. Neither is a loss: the story stays in `CHANGELOG.md` and the
mechanism on the wiki page. Compressed 2026-08-19 from 1570 lines to this, by moving every surviving
paragraph onto the page it pointed at and deleting the narratives whose code was already gone.

**What stays in `CLAUDE.md`** is the handful of rules that apply to EVERY task regardless of area,
plus the pointer here. Adding a rule there means asking first whether it belongs in a section below.

---

## MLS state and keys -> [mls-protocol](protocols/mls-protocol.md), [auth](frontend/modules/auth.md)

Everything that touches the device key, the PIN, `mls.bin` or an unlock path is on those two pages.
`desync` = [mls-desync-prevention](protocols/mls-desync-prevention.md).

**The send ratchet, and what may replace the client under it**

- **No state replacement may rewind this device's own send RATCHET, and an epoch cannot see that it did** - every such seam needs TWO guards, epoch-monotonic AND not-overtaken-by-a-local-send. [desync](protocols/mls-desync-prevention.md#8-client---no-state-replacement-may-rewind-this-devices-own-send-ratchet)
- **A rule that each call site must remember is a rule the next call site will NOT** - the checkpoint lived at 2 of the 18 call sites reaching a send; it is now inside `BaseMlsService.sendMessage`, which a platform cannot opt out of. [desync](protocols/mls-desync-prevention.md#8-client---no-state-replacement-may-rewind-this-devices-own-send-ratchet)
- **A call site that has to know WHICH PLATFORM it is on in order to persist will get it wrong** - `saveState` means two different things, and a second call site had its own copy of the answer. One seam, every checkpoint through it. [desync](protocols/mls-desync-prevention.md#8-client---no-state-replacement-may-rewind-this-devices-own-send-ratchet)
- **An invariant is not its first implementation - re-read what it actually DEMANDS before paying for it.** "`mls.bin` is never behind a frame that has left" never required durability at send time, and the expensive reading survived two design rounds. [desync](protocols/mls-desync-prevention.md#8-client---no-state-replacement-may-rewind-this-devices-own-send-ratchet)
- **Price both halves before choosing between them - an UNPRINTED metric is a guess.** The estimate was ~80 ms and the truth 1.7 s, and splitting the log exposed a duplicate write no reasoning had found. [desync](protocols/mls-desync-prevention.md#8-client---no-state-replacement-may-rewind-this-devices-own-send-ratchet)
- **When a repair can only be wrong in ONE direction, find out which and lean on it** - over-shooting the burn costs a peer a few unused keys, under-shooting refuses a frame; establishing the asymmetry in the dependency's source is what removed the need for atomicity. [desync](protocols/mls-desync-prevention.md#8-client---no-state-replacement-may-rewind-this-devices-own-send-ratchet)

**At rest**

- **What the device key SEALS, the device key change must RE-SEAL** - and whether forgetting is survivable depends entirely on whether something else still holds it. Before adding an encrypted store, answer: who else holds this, and what happens if this copy dies. [channel-encryption](protocols/channel-encryption.md)
- **A migration branch stamps its OWN version, never `SCHEMA_VERSION`** - stamping the current version claims every migration written after it. When bumping, READ the previous branch's stamp. [mob](frontend/mobile.md)
- **An at-rest envelope change needs a reader for the previous format in the SAME commit - and that only buys the FORWARD direction.** Say so at the commit: **the frontend must not be rolled back past `01bc0a13`.** [mls-protocol](protocols/mls-protocol.md#how-the-state-is-encoded-inside-the-envelope-wp-anr-1-2026-08-11)
- **serde has no `Vec<u8>`** - the generic sequence path is x45 slower and x2 larger, measured. Any NEW byte field uses `byte_compat.rs`. [mls-protocol](protocols/mls-protocol.md#how-the-state-is-encoded-inside-the-envelope-wp-anr-1-2026-08-11)

**Unlock**

- `isValidPin` (>= 4 chars) guards setup, change, recovery AND unlock - one rule, or a lockout. [auth](frontend/modules/auth.md#pin-and-device-key)
- **A status code is an ANSWER, a transport failure is not** - only a 401/403 may log a user out, and `navigator.onLine` never proves reachability. [auth](frontend/modules/auth.md#a-status-parsed-back-out-of-a-sentence-is-a-status-that-was-discarded)
- **Offline unlock is only ever the paths that ALREADY skip the server check online** (biometrics, vault); widening it to the PIN is a security change wearing a UX hat. [auth](frontend/modules/auth.md#offline-unlock)

## Community channels -> [chat](frontend/modules/chat.md), [social-service](services/social-service.md)

Deep links, system events, rosters and the channel/DM asymmetry are on those two pages;
`rework` = [community-rework](services/community-rework.md),
`graine` = [channel-encryption](protocols/channel-encryption.md).

- **A LISTING HAS NO AUTHORITY OVER A FACT CREATED AFTER ITS REQUEST WENT OUT.** A reconciliation that deletes whatever the server did not mention is right only about the moment it asked, and the workspace load spends SECONDS between the two - it joins a key group and lists the salons of every community before it prunes. A community created in that window was absent from an answer already in flight, and was deleted for it, together with the salon just made inside it: measured on prod, the community left the rail 1.5 s after it was created and the app dropped the user into an unrelated one, silently, so every gesture afterwards went to the wrong community. **Date the snapshot against local creations - a monotonic tick, never a clock** - and let the prune act only on what existed when it asked. Absent and not-yet-born are different facts. [chat](frontend/modules/chat.md)
- **A CREATION IS A GRANT, AND EVERY GRANT ANNOUNCES ITSELF.** Three paths put a user into a private salon's `allowedUsers` - an accepted invite, an admin join, an added member - and each publishes `channel.member.joined` to `channelAudience` AFTER the write, so the newly-admitted person is inside the audience rather than the one it misses. Creation told nobody, including the creator's OWN other devices, and the only other way into a private salon's distribution group is a full workspace load (post-login, the `online` event, a deep link). So a second device already running joined nothing and could not decrypt a word of the salon until it was relaunched. Measured by COMM-25 on prod: the phone joined the group of all three salons that existed when it loaded its workspaces and never heard about the one created nine seconds later. **When a set of paths writes the same field, the announcement belongs to the FIELD, not to the path** - enumerate the writers, never the ones that already announce. [social-service](services/social-service.md)
- **WHATEVER CREATES A THING PREPARES IT, because the creator is the first to USE it.** Creating a community dropped you into its first salon with the composer ready, and the first message was refused: a public salon seals to the COMMUNITY's group, and the only paths that ever ensured that group were the workspace LOAD and the creation of a PRIVATE salon. Preparation deferred to "the next load" is preparation that is missing for exactly the window in which the object is newest - and it HEALS, which is what hides it: a reload fixed it, and so did the first person joining. [graine](protocols/channel-encryption.md)

**Governance, and controls that destroy**

- **A RULE THE SERVER ENFORCES AND THE CLIENT HAS NEVER HEARD OF IS HALF A FEATURE** - the refusal is correct and the product still offers the control, so the person reads a 403 as a broken app. Send the DECISION, never the policy: a client holds none of the inputs (roles, permissions) the rule needs, so handing it the policy buys a second copy of the rule with half its arguments missing. `writePolicyAllows` is the only definition, read by `canWriteToChannel` and by the workspace listing. [social-service](services/social-service.md)
- **A DECISION SENT ONLY IN A LISTING IS A DECISION THE PERSON ALREADY IN THE ROOM NEVER GETS.** Teaching the listing to answer `viewerCanWrite` fixed COMM-7 for whoever loaded the community AFTER the change and for nobody else - the second run failed identically, because the device changing a rule is never the device holding the stale one. **A rule that can change while somebody is looking at it owes an announcement, and the announcement carries the DECISION** - so the audience is SPLIT BY THE ANSWER and each half addressed with its own verdict, since one payload cannot carry a per-viewer answer. Absent means UNCHANGED on the receiving side: a rename reuses the same event and must not silence a composer. [social-service](services/social-service.md)
- **TWO EDITS THAT COMMUTE MUST BE SENT AS THE OPERATIONS THEY ARE, NEVER AS THE STATE THEY PRODUCE.** A permission-grid cell IS a delta - grant this one key - and it was sent as the role's whole list, computed from what that browser held. Two administrators toggling two DIFFERENT keys of one role therefore did not race: the second write carried a list built before the first landed and erased it, and the loser's grid kept showing a permission the server had dropped AND one it had never stored. Optimistic concurrency would have been the other answer and a worse one - it turns two compatible edits into a conflict a person has to resolve. **A whole-state write is only honest when the writer owns the whole state.** Found on prod by COMM-20 on its first run. [social-service](services/social-service.md)
- **Every operation checks what the ACTOR may do; ask also what the SYSTEM would be left as.** Five paths removed the last admin - one absent postcondition seen from five sides, so guarding any one left the hole open. Enumerate the sides by asking what else WRITES the table. [rework](services/community-rework.md#axis-2---a-community-can-never-be-left-ungoverned---shipped-2026-08-18)
- **Enforce it as a REFUSAL wherever refusing is possible, and add no repair route** - making the broken state unreachable beats a destructive button that restores it. Where refusal is impossible, the repair is DETERMINISTIC, never a heuristic and never a clock. [rework](services/community-rework.md#axis-2---a-community-can-never-be-left-ungoverned---shipped-2026-08-18)
- **Recoverability that only recovers UNREADABLE rows is not recoverability** - when a soft delete's justification is the restore, re-ask whether the restore still produces something usable. **A SOFT DELETE THAT DESTROYS THE KEY IN THE SAME CALL IS A HARD DELETE THAT LIES**: it keeps the rows and throws away the only thing that made keeping them worth anything. [social-service](services/social-service.md#deleting-a-community-is-irreversible-and-the-gate-is-a-server-argument)
- **A RULE FIXED AT ONE SCOPE IS OWED TO EVERY SCOPE SHARING THE MECHANISM, and the smaller one is where nobody looks.** The community's soft delete was made real on 2026-08-18; the SALON's, one level down, same argument word for word, survived two more days and was found by a test asking whether the row was gone. When a finding is written as a sentence about a mechanism, enumerate what else runs that mechanism before closing it. [social-service](services/social-service.md#deleting-a-channel)
- **Turning a reversible control irreversible changes what every DEPLOYED client is saying - so go and READ what they say.** Where their wording promised the old meaning, the gate is a new argument they do not send, and they fail closed. Where it already promised the new one, adding an argument breaks working clients for nothing: `deleteWorkspace` needed `confirmationName`, `deleteChannel` needed no gate at all, because its dialog had said "definitivement" since the first version that shipped. **The rule is the reading, never the token.** A confirmation only the dialog enforces is a decoration. [social-service](services/social-service.md#deleting-a-channel-took-no-new-argument-deliberately-2026-08-20)
- **A link nobody can ENUMERATE is not revocable** - one live invite, rotation the only way to mint, and the bounds shown next to the token. [rework](services/community-rework.md#axis-3---an-invite-is-one-link-bounded---shipped-2026-08-18)
- **An action may only mutate state at its OWN scope** - an operation the model cannot express must be REFUSED, never approximated with the neighbouring scope's write, and `{ success: true }` that removed nothing is a lie. **Unmanageable is worse than gone.** [social-service](services/social-service.md)

**The key-distribution group, which is not a conversation**

- **A RULE READ AT TWO MOMENTS MUST BE GATED AT BOTH, and the second moment is where nobody looks.** `historyVisibility` was stored, broadcast, narrowed fail-closed and enforced on the join-time bundle - and the seed-REPAIR path, which no reader of that feature ever opens, handed the same past back one session id at a time, so a community that chose "rien de plus ancien" got the opposite. **Enumerate every place the guarded thing LEAVES, not every place the feature is mentioned**, and give the rule ONE module both callers read so the two readings cannot drift again. Found on prod by COMM-12; unreachable from the repository, because each path was correct in isolation. [graine](protocols/channel-encryption.md#wp-3435-and-the-rule-the-server-cannot-enforce)
- **AN INVARIANT THAT HOLDS "EVENTUALLY" DOES NOT HOLD AT THE INSTANT A GUARD READS IT.** The first fix withheld any seed minted before a member arrived, reasoning that a join advances the distribution group's epoch and rotation follows - true, but rotation is decided by the SENDER from the epoch it has PROCESSED, and a join is an EXTERNAL commit it learns of late. So a session spans the arrival and the guard withheld messages the member was entitled to. **A boundary drawn across a window somebody else closes must be drawn INSIDE the window's units** - here `firstIndex`, which already existed for it - and the same run that found the first defect is what found this. When a rationale says "by construction", name the actor that performs the construction and ask when. [graine](protocols/channel-encryption.md#wp-3435-and-the-rule-the-server-cannot-enforce)
- **WHEN TWO DEVICES MUST AGREE ON A NUMBER, HAVE THE SERVER COMPUTE IT.** The history floor compares a member's arrival with each message's date; both are server columns written by one clock, so asking the server removes every device clock from the decision and makes each answerer arrive at the same number. A client-side comparison of a server-stamped arrival against a peer's device-stamped mint time would have been sharp only to that peer's skew - correct almost always, which is the worst kind. [graine](protocols/channel-encryption.md#wp-3435-and-the-rule-the-server-cannot-enforce)
- **AN ADD-IF-ABSENT ON A REFRESH PATH DISCARDS THE REFRESH, SILENTLY AND FOR THE WHOLE SESSION.** `addChannelToWorkspace` ignored a channel already in the sidebar, and the full re-read from the server calls it for every channel it just fetched - so an entry kept whatever it was created with. It hid the administrator join: the server answered `viewerHasAccess: true`, and the row went on offering "Rejoindre" for ever. **When a function is reused by a REFRESH, "already there" means UPDATE, not skip** - and the update MERGES, because a field the reload does not carry (`unreadCount`) must not be erased by one that does. Found on prod by COMM-13, whose four other assertions all passed: the join was complete everywhere except on the screen of the person who performed it. [chat](frontend/modules/chat.md)
- **A LIST IS AUTHORITATIVE ONLY FOR THE POPULATION IT WAS WRITTEN TO ENUMERATE.** `getUserGroups` answers for CONVERSATIONS and excludes a community's distribution group deliberately; two reconcilers read it as "every group this device may hold" and destroyed that group on every connection, checkpointing the loss - so nobody could send in any community. Absence from a list is a reason to ASK, never a reason to destroy. [graine](protocols/channel-encryption.md#the-distribution-group-is-not-a-conversation-and-two-sweeps-assumed-it-was)
- **The sweep that would have destroyed a thing is where it should LEARN what the thing is** - one row read, the discriminator registered, and every later sweep in the session answers locally. That is what removes the race, not an ordering between two async paths. [graine](protocols/channel-encryption.md#the-distribution-group-is-not-a-conversation-and-two-sweeps-assumed-it-was)
- **NOT ACKNOWLEDGING IS ONLY RIGHT WHILE REDELIVERY CAN STILL HELP.** A frame the crypto layer already classified as unreadable for good - a past epoch, a spent generation, this device's OWN frame - comes back for ever if the refusal is blanket. Classify at the throw and acknowledge the permanent ones; a lost seed is recovered by ASKING a peer, never by a redelivery. [graine](protocols/channel-encryption.md#the-distribution-group-is-not-a-conversation-and-two-sweeps-assumed-it-was)

**When somebody leaves**

- **A PREMISE STATED IN A DOC-COMMENT IS NOT A MECHANISM.** Graine's rotation fired on an epoch that changed, and its own doc said "every membership change commits to the distribution group and advances its epoch". Nothing did. When a security property rests on a sentence, go and find the code that makes the sentence true, or write it. [graine](protocols/channel-encryption.md#10-a-departure-moved-nothing-and-rotation-waited-on-it---fixed-2026-08-19)
- **REVOCATION HAS TWO HALVES AND THEY ARE NOT SYMMETRIC.** Routing is revoked server-side, immediately, with nobody online; the cryptographic half is a commit only a remaining member can produce, so it is lazy. Do the server half FIRST and let it abort the removal: the lazy half self-heals on the next load, a routing row left behind never does. [graine](protocols/channel-encryption.md#10-a-departure-moved-nothing-and-rotation-waited-on-it---fixed-2026-08-19)
- **A DIFF CONVERGES WHERE AN EVENT RACES.** A departure notice reaches only who is online and only one of them may act; a diff between two authoritative lists is the same answer whoever runs it, whenever, and ends at "nothing to do". Prefer it to an elected committer or a durable "somebody left" marker. [graine](protocols/channel-encryption.md#10-a-departure-moved-nothing-and-rotation-waited-on-it---fixed-2026-08-19)
- **THE TREE IS THE AUTHORITY ON WHO CAN READ; A ROUTING TABLE ANSWERS WHO GETS SENT TO.** They are different questions, they disagree (a fresh-started device empties its rows while its leaf stands), and a removal decision that reads the second locks out members it should keep. [graine](protocols/channel-encryption.md#10-a-departure-moved-nothing-and-rotation-waited-on-it---fixed-2026-08-19)
- **AN IDENTIFIER THAT IS A PREFIX OF ANOTHER NEEDS THE SEPARATOR IN THE COMPARISON.** `remove_members_for_users` compared a bare user id with a `userId:deviceId` credential and matched nothing at all - a whole removal path inert, with no test, for as long as it existed. Compare against the shape the value actually has. [graine](protocols/channel-encryption.md#10-a-departure-moved-nothing-and-rotation-waited-on-it---fixed-2026-08-19)

**Two messaging systems, one product**

- **A CHANNEL AND A DM MUST FAIL THE SAME WAY, or the difference teaches the user something false.** Graine's §4.5 required a "unreadable, key on the way" placeholder that MLS DMs deliberately do not have: an unopenable frame is logged, reconciled and never shown. The doc was corrected to the code, not the reverse - and a placeholder added to one of the two now has to be added to both. When a rule about presentation is written for ONE of them, go and read what the other does before writing it. [graine](protocols/channel-encryption.md#45-a-missing-seed-is-requested-and-said-out-loud)

**Who an event is ADDRESSED to**

- **AN AUDIENCE IS DERIVED FROM ACCESS, OR IT IS NOT AN ACCESS CONTROL.** Every channel event was published to `getWorkspaceMemberIds` - a question about the CONTAINER - while `canAccessChannel` only ever ran on the ACTOR. A private salon's ciphertext, typing, pins and tallies went to members the same server refuses over REST, who already held the seed. Ask of every fan-out which question its recipient list answers. [graine](protocols/channel-encryption.md#11-a-private-salons-ciphertext-was-addressed-to-the-whole-community---fixed-2026-08-19)
- **THE PATH THAT LOOKS RISKY GETS READ; THE ONE THAT LOOKS LIKE PLUMBING DOES NOT.** Push filtered correctly because it was written per recipient and reached for the guard naturally; the WebSocket fan-out, three lines away, did not. When one of two paths to the same data is right, that is evidence about its AUTHOR, never about the other. [graine](protocols/channel-encryption.md#11-a-private-salons-ciphertext-was-addressed-to-the-whole-community---fixed-2026-08-19)
- **A RULE WITH THREE IMPLEMENTATIONS HAS A FOURTH PLACE THAT NEEDED IT AND HAS NONE.** Channel readability was hand-rolled in the guard, in the roster listing and in the push loop - and absent from the audience. Extract it PURE, with the expensive lookup passed in, so each caller supplies it from what it already holds. [graine](protocols/channel-encryption.md#11-a-private-salons-ciphertext-was-addressed-to-the-whole-community---fixed-2026-08-19)
- **DERIVING AN AUDIENCE FROM ACCESS MAKES ORDER LOAD-BEARING AT EVERY MOMENT ACCESS CHANGES.** Grant BEFORE announcing, or the invitation reaches everyone but the invitee; revoke BEFORE announcing and add the subject back BY NAME, because losing access is the one event its subject must receive. [graine](protocols/channel-encryption.md#11-a-private-salons-ciphertext-was-addressed-to-the-whole-community---fixed-2026-08-19)
- **SERVER-ENFORCED AND END-TO-END ARE DIFFERENT GUARANTEES, AND A PRODUCT MAY ONLY CLAIM THE ONE IT HAS.** A private salon's seed rides the COMMUNITY's distribution group, so every member holds the key; scoping the fan-out stops the server handing over the ciphertext and nothing more. Say which of the two a feature has, in the protocol page, before anyone infers the stronger one. [graine](protocols/channel-encryption.md#11-a-private-salons-ciphertext-was-addressed-to-the-whole-community---fixed-2026-08-19)

**Two clocks, and the answers derived from them**

- **Two windows meant to be one will DRIFT: derive the second from the first, never re-time it** - and a second copy of the number cannot know about the EXCEPTIONS. The device asks which sessions still have messages and forgets the rest. [graine](protocols/channel-encryption.md)
- **A derived answer must not conflate "gone" with "not there YET", nor with "NO ANSWER"** - the age check separates the first pair, failing closed separates the second. Both are tests. [graine](protocols/channel-encryption.md)

**Small ones that keep costing**

- Never return a `Channel` entity to a client: it carries `masterSecret`. Project fields explicitly. [social-service](services/social-service.md)
- `/c/<groupId>` and `/chat/<groupId>` are NOT routes; a conversation opens by publishing to `notifNav`. [chat](frontend/modules/chat.md#deep-linking-into-a-channel)
- **"A refresh ran" and "the list is current" are two different facts** - a loader that conflates them empties the sidebar on one dropped request. Fail loudly in state, never by returning stale truth. [chat](frontend/modules/chat.md)

## MLS membership and routing -> [mls-protocol](protocols/mls-protocol.md), [chat-delivery](services/chat-delivery.md)

`mls` = [mls-protocol](protocols/mls-protocol.md), `cd` = [chat-delivery](services/chat-delivery.md),
`hr` = [history-reconciliation](protocols/history-reconciliation.md),
`chat` = [chat](frontend/modules/chat.md).

**Who may do what, and who is told**

- **A CAPABILITY REMOVED IS URGENT IN A WAY A CAPABILITY GRANTED IS NOT** - a promotion arriving late is an annoyance, a demotion arriving late leaves somebody clicking controls the server now refuses. Push the change to the subject, carrying what the role GRANTS, not its name. [backlog](backlog.md)

- **A permission check that runs where the action is OFFERED is not a check** - where the server cannot read the content, the RECEIVER enforces it, against the identity MLS authenticated. [chat](frontend/modules/chat.md)
- **An answer broadcast to a group is read by every member, so it must NAME the one it answers** - at the DEVICE (`digestIdentity`), never the user. DATA is for everyone, the ANSWER is for the addressee. [mls](protocols/mls-protocol.md)
- **A legacy frame with no addressee resolves towards the marker STAYING UP**: an extra diff is free, a marker wrongly cleared is permanent. [legacy-compatibility](legacy-compatibility.md)
- **Do NOT narrow an MLS application message with `recipients` to address it** - `sender_ratchet_config()` is (2000, 2000) and a per-recipient re-encryption burns it into a generation gap. Addressing belongs in the PAYLOAD. [chat](frontend/modules/chat.md)
- **A timer that compensates for two transports being unordered is a guess; make the FRAME say which case it is** (`withDigest`). What is left is a BOUND, and a legitimate bound's being reached is not a tuning question. [legacy-compatibility](legacy-compatibility.md)
- **Every compatibility shim goes in [legacy-compatibility](legacy-compatibility.md) with the condition that retires it** - the gate is `minClientVersion` raised past it, never "the release is out".
- MLS membership says who can DECRYPT; `DeviceGroupMembership` says who is actually SENT to. [mls](protocols/mls-protocol.md)
- **ONE MAP ANSWERING TWO QUESTIONS MAKES THE CHEAP ONE WAIT ON THE EXPENSIVE ONE** - "is this a distribution group" needs only the server's row, "whose roster is it" needs a community the row cannot carry, and holding both in one `Map` made the first answer FALSE about groups the server had just named. Split the store, not the call sites. [graine](protocols/channel-encryption.md#two-more-from-reading-one-warning-nobody-had-classified)
- **A WARNING THAT NAMES A CAUSE IS A CLAIM ABOUT THAT CAUSE, and it is cheap to refute** - `is not handled by this client` said VERSION SKEW on two clients running the same bundle. An unclassified line is not noise to be filtered; it is the visible end of something. [graine](protocols/channel-encryption.md#two-more-from-reading-one-warning-nobody-had-classified)
- **A ROSTER WRITTEN ONLY BY THE ACTORS OF A CHANGE HAS NO ROW FOR WHOEVER CREATED THE THING** - `DeviceGroupMembership` is written by the commit fan-out, whose activating device is the SENDER, and a group's creator sends no commit. Ask of every derived set which act writes it, then name the act it cannot see. [graine](protocols/channel-encryption.md#the-fourth-and-the-worst-the-device-that-created-a-group-was-on-no-roster)
- A join is NOT evidence of a gap - the message store and the seen-frame ledger are keyed by USER. [chat](frontend/modules/chat.md)
- **A LOCAL GROUP IS A MEMORY OF HAVING JOINED, NEVER EVIDENCE OF MEMBERSHIP** - the eviction that deletes the delivery rows is immediate, the MLS Remove is committed later BY A REMAINING MEMBER and published to a group the leaver is already unrouted from, so the leaver is the one party that can never learn it was removed. Its belief is therefore permanent, and re-granting it changes nothing while the join - the only writer of those rows - is skipped on the strength of that belief. Ask the side that HOLDS the fact (`memberDevices`), and forget before re-joining, because the join returns early on a group it already holds. [graine](protocols/channel-encryption.md#the-asymmetry-has-a-third-half-coming-back---fixed-2026-08-21-wp-regrant-1)
- **A PREDICATE THAT ANSWERS "WHAT IS THIS" IS NOT EVIDENCE OF "DOES IT STILL EXIST"** - `isDistributionGroup` was written so a sweep would not destroy a live seed carrier, and reading it as proof the group is alive short-circuited the one read that could have said otherwise. The two facts differ only in LIFETIME: the predicate holds for the session, the group can die inside it. And whenever a shortcut SPARES something, ask what else could ever collect it - here the owner of that job enumerates SCOPES, and a carrier noted without one is in none of them, so nothing could. [graine](protocols/channel-encryption.md#a-community-deleted-left-its-seed-carrier-held-for-ever---fixed-2026-08-21)
- **FORGETTING A THING MUST FORGET WHAT CLASSIFIED IT, OR THE PREDICATE OUTLIVES THE THING** - an entry left in `knownDistributionGroups` goes on answering "seed carrier" about state the device no longer holds, and the sweep that spares a seed carrier by design then spares the leftover for ever. One helper drops the pair; every site that drops a group uses it. [graine](protocols/channel-encryption.md#a-community-deleted-left-its-seed-carrier-held-for-ever---fixed-2026-08-21)
- **A DESTRUCTIVE REPAIR MUST NOT BE REACHABLE FROM ANOTHER CALLER'S HALF-FINISHED WORK** - two `ensureDistributionGroupFor` calls fired on ONE gesture (creating a private salon initialises its group; the workspace refetch that lists it enters every private salon's group), both published epoch 0, and the second read a group held locally with no roster row - indistinguishable from an eviction - so it forgot the tree the first had just built and re-joined. The repair was right about what it saw. **Share ONE in-flight promise per scope**: every caller wants the same postcondition, so the second wants the first's ANSWER, not a second attempt. Keyed on the scope, never on a done-flag - a flag is a second bookkeeping layer able to lag the tree - and deleted in `finally`, or the first join of a session answers the re-join a revoke makes necessary. [graine](protocols/channel-encryption.md#one-gesture-called-the-join-twice-and-the-second-call-repaired-the-first-ones-half-finished-work---fixed-2026-08-21)
- **A CHECK GATED ON A SECOND COPY OF THE FACT IS SKIPPED EXACTLY WHERE IT IS NEEDED** - the scope->group registration and the held MLS tree are two records of one membership, and the state worth repairing is the one where they disagree. Take BOTH sides of the comparison from the answer that names the thing (`ref.groupId`), and repair through the same name. [graine](protocols/channel-encryption.md#the-asymmetry-has-a-third-half-coming-back---fixed-2026-08-21-wp-regrant-1)
- **AN ABSENT ANSWER IS NOT A NEGATIVE ANSWER** - `undefined` from a server that was not asked, or a fetch that threw, must leave behaviour EXACTLY as it was; only a present-and-empty list is the statement "this group would deliver you nothing". **And it must SAY it was absent** - "the roster agreed" and "nobody asked" reaching a run log identical is what let a no-op fix pass for a working one. [graine](protocols/channel-encryption.md#the-asymmetry-has-a-third-half-coming-back---fixed-2026-08-21-wp-regrant-1)

**Markers, and what discharges them**

- **A durable marker must carry the EVIDENCE that justified it**, or nothing can revisit the diagnosis; one written without evidence is legacy - drop it, do not replay it. [hr](protocols/history-reconciliation.md)
- **A marker is discharged by anything that FALSIFIES ITS OWN EVIDENCE, not only by the answer it waited for** - so the discharges differ per reason, and a guard implemented as SILENCE makes a fixed point no convergence argument covers. [hr](protocols/history-reconciliation.md)
- **A device that has not noticed its own gap will VOUCH for its store**, promoting a silent upstream failure into a trusted witness for everyone else's repair. [hr](protocols/history-reconciliation.md)
- **A responder is elected at RANDOM among the online devices**, so any check on a repair must record WHICH device answered - the greener verdict is the one that says less. [testing-methodology](testing-methodology.md)

**Ghosts, debris, and the reports that find them**

- **A liveness clock must be WRITTEN BY the thing whose liveness it measures** - `updatedAt` answers "when was this row written", not "when was this device seen" (WP-GHOST-1). [chat](frontend/modules/chat.md)
- **A predicate that named the last incident is not the predicate that names the next one** - one `GROUP BY` with it as a column settles it in seconds. [storage-forecast](infrastructure/storage-forecast.md)
- **A correct GC with no REPORT is found by hand, a day late** - and the report must carry the evidence separating the causes it cannot itself distinguish. [cd](services/chat-delivery.md)
- **A device good enough to be MESSAGED must be at least as valid as one good enough to be INVITED** - the invitation path checks the key package, the fan-out does not. [cd](services/chat-delivery.md)
- **When a resource keeps refilling, deleting it is not the fix - REVOKE whatever keeps naming it as a destination.** A DELETE leaves the routing memberships standing and the count starts over. [cd](services/chat-delivery.md)
- **When two paths both END the same thing, "what it owns" is ONE exported list or it is neither** - and the owned rows drop in the SAME transaction as their parent. [cd](services/chat-delivery.md)
- **THE LIST IS OWED BY EVERY ROUTE THAT ENDS THE THING, NOT BY THE JOBS THAT COLLECT ONE** - the rule above shipped, and for three days its only callers were the reaper and the orphan sweep while all THREE delete routes still carried a hand-written subset, one of them empty. The doc said "both ways a group ends call it" and named the two collectors, which is a claim about the wrong pair. When a shared list lands, enumerate its call sites against the acts that END the thing. [cd](services/chat-delivery.md#what-a-group-owns-and-the-one-list-that-says-so)
- **A ROW KEPT ON PURPOSE HIDES ITS OWN LEAK, PERMANENTLY** - the orphan sweep finds groups with NO row, so it is structurally blind to whatever a SOFT-delete forgot: the tombstone survives by design, so nothing collects the residue before the 90-day reaper. Whenever a deletion leaves a marker behind, ask which collector can still see what it left - and if the answer is the same job that keyed on absence, there is none. [cd](services/chat-delivery.md#what-a-group-owns-and-the-one-list-that-says-so)
- **A ROW IS NOT A DESTINATION: PRESENCE AND DELIVERABILITY ARE TWO QUESTIONS** - `purgeOrphanGroups` answered "does the row exist" while its own doc named the other one, "still present (deliverable)", and the two differ by exactly the tombstones. Handing a frame to a client that can neither decrypt nor ACK it starts a loop nothing terminates: it asks for keys, is told nothing, keeps the frame, meets it again next connection. The one-word conflation was in the DOC first. And return the two sets NAMED, because the causes accuse different code - absent is this call's to repair, tombstoned is a delete route's. [cd](services/chat-delivery.md#a-row-in-dm_groups-is-not-a-place-a-frame-can-go)
- **A SHARED "WHAT IT OWNS" LIST IS NOT THE SAME LIST FOR A SOFT DELETE AND A HARD ONE** - one member of it, `dm_user_dismissed_groups`, is a fact about a PERSON that is BUILT to outlive the group row (text, not a relation, and its entity says so twice). A hard delete may take it because nothing will ever ask again; a SOFT delete must not, because the tombstone means discovery still asks, and without the marker it reads "somebody else deleted this" and shows a banner to the one person who asked for silence. Unifying three soft routes onto the list put all three on the wrong side of that, and a by-hand repair took 25 rows before anybody noticed. Before adding a table to such a list, ask WHOSE fact the row is and WHO still reads it after the parent dies - and let the caller declare which kind of death it is. [cd](services/chat-delivery.md#what-a-group-owns-and-the-one-list-that-says-so)
- **A SECOND COLLECTOR FOR RESIDUE THE FIRST ONE SHOULD HAVE TAKEN HIDES THE FIRST ONE'S ABSENCE** - so the fetch path DROPS an undeliverable frame and NAMES its group at WARN, and sweeps nothing: the rows exist because a delete route leaked, and the fix belongs there. [cd](services/chat-delivery.md#a-row-in-dm_groups-is-not-a-place-a-frame-can-go)
- **A sweep that looks for orphans where the reaper already deleted finds none, and reads as PROOF that there are none.** Read a cleanup's predicate against what runs BEFORE it. [cd](services/chat-delivery.md)

**Classifying a decrypt failure**

- **An error says what it says**: "this generation is consumed" is NOT "I already have this message". A layer that cannot make a distinction must not make it - the guard is `same_epoch_ratchet.rs`, not a comment, and a test asserting the swallow will happily protect the bug. [mls](protocols/mls-protocol.md)
- **EPOCH and GENERATION are different axes, and so are their repairs** - a verdict computed over one must never answer a question asked about the other. [mls-recovery-ladder](protocols/mls-recovery-ladder.md)
- A wrapper string carries BOTH markers (`GAP_QUEUED:<group>:<error>`), so the ORDER of a substring classifier is a decision. [mls](protocols/mls-protocol.md)
- **A shim that downgrades a log's severity by RE-READING ITS TEXT is a missing classification, announcing itself** - where the demotion is, the classification is not, and the platform doing the damage is the one with no demotion at all. [mls](protocols/mls-protocol.md#our-own-frame-was-classified-as-a-retryable-gap-2026-08-15)
- **Severity is the CLASSIFICATION's to report, not the bare fact that a call returned `Err`.** Only what nothing has explained keeps `error!`. [mls](protocols/mls-protocol.md)
- **A comment asserting where a line comes from is a CLAIM, and it is cheap to refute** - a bad measurement is worse than none, because it gets written down. [testing-methodology](testing-methodology.md)

## Outbound delivery -> [chat](frontend/modules/chat.md), [history-reconciliation](protocols/history-reconciliation.md), [chat-delivery](services/chat-delivery.md), [mobile](frontend/mobile.md)

The largest area here, and the one that has cost the most. `chat` = [chat](frontend/modules/chat.md),
`hr` = [history-reconciliation](protocols/history-reconciliation.md),
`cd` = [chat-delivery](services/chat-delivery.md), `mob` = [mobile](frontend/mobile.md).

**The queue, and cancelling what is in it**

- Every step is best-effort, so **every swallowed branch logs**. [chat](frontend/modules/chat.md#outbox-outbound-delivery)
- **EVERY MESSAGE KIND LOGS ITS ARRIVAL, INCLUDING THE ONE THAT RENDERS NOTHING.** Text, media, reactions and calls each announced themselves; a SYSTEM event announced nothing, so a frame that decrypted and produced no visible change left no trace on any machine and could not be told from one that never arrived. A branch may still decline what it was sent - most system events are addressed - but the DISPATCH is a fact, and a fact nobody records is one the next reader has to reproduce on a live browser. [chat](frontend/modules/chat.md)
- **A `catch { /* noop */ }` around a PARSE turns malformed into absent.** An event whose payload did not parse was handled as an event with no data, which every addressed branch reads as "not for me" and answers by succeeding. [chat](frontend/modules/chat.md)
- **An operation on a queued object must CONSULT the queue, never queue a second one beside it.** [chat](frontend/modules/chat.md#outbox-outbound-delivery)
- **A branch the callee took is a fact the caller needs - return it as a TYPE.** [chat](frontend/modules/chat.md#outbox-outbound-delivery)
- **A cancellation is only as deterministic as the narrowest window it closes.** [chat](frontend/modules/chat.md#outbox-outbound-delivery)
- **Bound the work that consumes an IRREVERSIBLE resource, not the work that costs time.** [chat](frontend/modules/chat.md)
- **The record of what is still owed is only as durable as its last write.** [mob](frontend/mobile.md)
- **The native mirror is READ as well as written**, so a wholesale rewrite needs an adoption pass. [mob](frontend/mobile.md)
- **A per-item API makes the per-item cost invisible**; across an FFI boundary the batch belongs on the SHARED side. [mob](frontend/mobile.md)

**Paging, and the deadlines over it**

- **A page is a unit of transfer, so bound it in the unit that decides how long the transfer takes** - and never below one row. [cd](services/chat-delivery.md)
- **Terminate a paged pull on an EMPTY page, never on a short one.** [cd](services/chat-delivery.md)
- **A pagination cursor must be a total order, or a page boundary deletes a row.** [cd](services/chat-delivery.md)
- **A deadline's SCOPE is part of its meaning**: per page, ACKed as it lands - partial progress must be kept. [cd](services/chat-delivery.md)
- **A deadline over a transfer must measure SILENCE, not elapsed time** - and carry "did the head arrive" out as a type. [cd](services/chat-delivery.md)
- **A lookup inside a per-item loop is a cost that grows with the wrong thing**; an index replacing a `find` keeps FIRST-wins. [hr](protocols/history-reconciliation.md)
- **Concurrency needs a BOUND, never a bare `Promise.all`.** [hr](protocols/history-reconciliation.md)

**What is on screen, and what wrote it**

- **A page read is evidence about a window of the past, never a statement that nothing else exists - so it is MERGED, never ASSIGNED.** [chat](frontend/modules/chat.md#a-page-read-is-merged-into-the-list-never-assigned-over-it)
- **MLS gives no echo of your own message**: apply the optimistic update in memory AND persist it. [chat](frontend/modules/chat.md)
- **A UI buffer placed in FRONT of a persistence call is a persistence bug.** [chat](frontend/modules/chat.md)
- **A count taken before decryption cannot classify what it counts**; and one flag must not carry two questions. [chat](frontend/modules/chat.md)
- **A cause is not a label**: two causes under one string is a WRONG answer, not a vague one. [chat](frontend/modules/chat.md)

**The drain, and the barriers around it**

- **A tab is "read-only" only where something CHECKS**, and whoever inherits the role must reload its state. [chat](frontend/modules/chat.md)
- **A repair whose result nobody reads must be STARTED, never awaited** - an await inside the drain freezes all inbound traffic. [chat](frontend/modules/chat.md)
- **A mutual-exclusion window needs ONE entry point for awaiting.** Report the freeze, never trade it for a loss. [chat](frontend/modules/chat.md)
- **A termination proof covers the structure it is written over**, so **a window must be closed by what opened it, through one exit.** [chat](frontend/modules/chat.md)
- **`requestAnimationFrame` never fires in a hidden document**, so it can never be the only resolver of anything. [chat](frontend/modules/chat.md)
- **Read your own mail before asking anyone for news - and before answering anybody.** [hr](protocols/history-reconciliation.md)
- **A barrier may not be awaited from inside the thing that holds what it waits for**; it refuses rather than hangs. [hr](protocols/history-reconciliation.md)
- **A barrier that also ACTS must not be reachable before the thing that answers for its action.** [hr](protocols/history-reconciliation.md)
- **`void` is not deferral** - a trigger raised from inside a region runs inside it. [hr](protocols/history-reconciliation.md)
- **A global depth cannot name an owner, so the report must name the caller.** [hr](protocols/history-reconciliation.md)

**Repair, and what makes it stop**

- **Idempotence comes from durable state, termination from a proof - never from a clock.** [hr](protocols/history-reconciliation.md)
- **But durable state answers only THE QUESTION IT WAS WRITTEN FOR, and two questions can differ only in lifetime.** [hr](protocols/history-reconciliation.md#the-marker-carried-something-is-missing-and-i-still-owe-an-ask)
- **When durable state is hard to discharge, check whether the thing it rations still needs rationing.** [hr](protocols/history-reconciliation.md)
- **A trigger that arrives before its mechanism must be HELD, not logged and dropped** - defer by BLOCKER, discharge on the act. [hr](protocols/history-reconciliation.md#a-group-that-could-not-heal)
- **An accidental repair hides the fault that needs it.** [hr](protocols/history-reconciliation.md#a-group-that-could-not-heal)
- **A fix that holds a raised trigger does not reach backwards**: damaged state needs a reason to COMPARE, not a cleanup. [hr](protocols/history-reconciliation.md#and-the-fix-does-not-reach-backwards---hence-the-audit)
- **A retry must terminate on the EVENT that changes the answer**, and that event is usually already named somewhere. [hr](protocols/history-reconciliation.md)
- **A repair that records its own output as new input has no fixed point.** [hr](protocols/history-reconciliation.md)
- **A repair ladder is ordered by what each rung can FIX; a rung that can fix nothing is deleted, not demoted.** [hr](protocols/history-reconciliation.md)
- **A repair addressed by TIME is a broadcast, because a window cannot name its target.** [hr](protocols/history-reconciliation.md)

**The shared ledger**

- **A frame read by one path must be marked read for every other path**, keyed by the CIPHERTEXT, in one object, advancing by WALKING. [hr](protocols/history-reconciliation.md)
- **"Every other path" means BOTH directions**; which ledger is settled by the QUESTION'S LIFETIME, and marks go on the SUCCESS path only. [hr](protocols/history-reconciliation.md#the-ledger-was-one-way-and-the-false-loss-moved-to-the-head-of-the-stream)
- **A ledger must be WRITTEN where the thing it records happens**, not where it is convenient to iterate. [hr](protocols/history-reconciliation.md)
- **And READ where the verdict is formed** - an answer obtained before an await is about a world that has moved. [hr](protocols/history-reconciliation.md)
- **A ledger that reconciles an overlap is not an order, and must not carry the ordinary case.** [hr](protocols/history-reconciliation.md)
- **A name that lies makes two key spaces read as one.** Rename on sight. [hr](protocols/history-reconciliation.md)

**What travels, and what is merely an event**

- **An answer must state the range it vouches for**, and is sent even when the state keys MATCH - agreement is not completeness. [hr](protocols/history-reconciliation.md#the-fourth-trigger-an-answer-that-does-not-reach-far-enough-back)
- **State that outlives the event that created it must travel AS STATE, not only as that event.** [hr](protocols/history-reconciliation.md)
- **A mutation that carries no clock cannot be merged** - date both legs, give ties a rule, and make the tombstones travel. [hr](protocols/history-reconciliation.md)
- **An event falling through a handler chain unhandled is an accident until it is NAMED.** [chat](frontend/modules/chat.md)
- **A response header is invisible cross-origin unless it is EXPOSED** - mobile only, compiles, deploys green. [mob](frontend/mobile.md)

**Four invariants of the history exchange that look like complications and are not** ([hr](protocols/history-reconciliation.md)):

- `historyWindow.ts` is the **only** place either boundary is decided, and `deviceWindowStart` rounds DOWN to the day.
- **`since` is stated by the asker, the digest is not clipped, the clip is on the ANSWER, each leg states its own window.**
- **`toConversationMeta` and the seed in `loadExistingConversations` are MIRRORS, edited together.** [why](protocols/history-reconciliation.md#the-two-hydration-paths-are-mirrors-and-must-be-edited-together)
- **`DELIVERY` in `frameDelivery.ts` is the only classification**, and the server gate reads `body.durable`.

**And one about believing any of it:** a prospective fix cannot be verified by the first measurement
after its deploy - build the run that DISCRIMINATES, and assert the build id, never the deploy.
[testing-methodology](testing-methodology.md)

## UI and i18n -> [frontend/architecture](frontend/architecture.md), [auth](frontend/modules/auth.md) (native prompts)

`arch` = [frontend/architecture](frontend/architecture.md), `posts` = [posts](frontend/modules/posts.md),
`chat` = [chat](frontend/modules/chat.md), `mob` = [mobile](frontend/mobile.md).

**Lifetimes, and state that goes stale under you**

- **A cleanup that releases something acquired ASYNCHRONOUSLY must wait for the acquisition** - release inside the pending promise's `finally`, never beside it. [arch](frontend/architecture.md#a-cleanup-that-releases-something-acquired-asynchronously-must-wait-for-the-acquisition)
- **An index into an array you do not own is state that goes stale, and `slice` past the end is SILENT** - clamp on the READ side, never recompute on the write side (WP-EMPTYVIEW-1). [chat](frontend/modules/chat.md)
- **A promise that has REJECTED stays rejected**, so state a retry writes must be read from OUTSIDE the thing that failed. [posts](frontend/modules/posts.md#why-the-feed-reads-postsoverride-outside-the-await)
- **A synchronous "unknown" PLACEHOLDER is indistinguishable from an answer once stored** - return the absence, never the label. [arch](frontend/architecture.md#a-synchronous-unknown-placeholder-is-indistinguishable-from-an-answer)

**Strings, and who is allowed to write them**

- **Nothing types a string as user-visible, so no compiler enforces Paraglide.** Default to it for ANY new user-visible string on the FIRST draft; a file's existing raw literals are not a precedent to extend. [arch](frontend/architecture.md#i18n-paraglide)
- **No user-facing string may name a sensor** - "empreinte ou Face ID" is wrong on every device, half the time. [auth](frontend/modules/auth.md)
- **A language setting belongs to the APP, not to the phone - and the RECEIVER is what picks it.** Paraglide covers the bundle and nothing else, so each native surface needs its own table AND its own resolver. [mob](frontend/mobile.md#the-language-a-notification-speaks)
- **The layer that cannot know the reader's language must not write the SENTENCE** - send a key from a closed set plus only what is untranslatable; a `locale` column is the wrong repair. [mob](frontend/mobile.md#the-language-a-notification-speaks)
- **A seam no build checks needs a test that reads BOTH sides** - `nativeStrings.test.ts`, mutation-checked by deleting one string. [mob](frontend/mobile.md)
- **A dev-facing sentence is a decision to report NOTHING, and it expires the day a surface appears** - giving a refusal a surface is what makes its string user-visible, so both land in the SAME change. Classify at the throw, switch exhaustively, keep `detail` untranslated and off screen. [backup](frontend/backup.md)
- **A rule that says "remember to run X first" is a MISSING DEPENDENCY, not a rule** - when two scripts need the same precondition and only one declares it, the other has a bug. [arch](frontend/architecture.md#linting-and-checks)

**Widgets**

- **A one-way colour is a dark-mode bug waiting to happen** - use the `app.css` tokens, and do not "fix" the 31 the sweep left deliberately. [arch](frontend/architecture.md#finding-one-way-colours)
- **Portalling a dropdown breaks its accessible RELATIONSHIP as well as its positioning, and nothing warns** - `aria-controls`, and a DISCLOSURE role, never `role="menu"`. [arch](frontend/architecture.md#an-anchored-dropdown-must-be-portalled-never-absolutely-positioned)
- **Two copies of a dialog do not stay identical, they stay PLAUSIBLE** - one shell owns chrome, focus and Escape, and deliberately NOT the content area (WP-VIEWER-1). [posts](frontend/modules/posts.md#the-two-viewers-share-one-shell-and-two-zoom-models-wp-viewer-1-2026-08-11)
- **A shared GESTURE is shared as arithmetic, not as a component** - the two zoom models are not interchangeable, and "unzoom puts it back" is the one thing a user may assume. [posts](frontend/modules/posts.md#the-pinch-and-why-it-needs-a-focal-point)
- **A TLD-shaped ending cannot decide what is a domain in French** - an exact whitelist sidesteps the ambiguity instead of out-narrowing it (WP-LINK-1). [posts](frontend/modules/posts.md#autolinking-bare-domains-and-why-the-tld-shape-cannot-decide-it-wp-link-1)
- **AN ICON THAT CLEARS ITS FOUR SIDES IS STILL CROPPED BY EVERY CIRCULAR MASK** - a drawing's extremities sit on the DIAGONALS, so the inset a circle demands is far larger than the eye estimates: the canari reached 1.347 of its inscribed radius, and the obvious tenth off left it at 1.177, still outside. Measure the reach, do not pick a percentage. The margin belongs in the VECTOR, because a tab chip, a launcher and a rounded tile all scale the whole canvas and have none of their own to give - and the factor gets ONE home, since a second copy drifts from the drawing and the symptom is launcher icons a tenth too small on a surface nobody checks after a deploy. [logo-render.mjs](../../frontend/scripts/logo-render.mjs), pinned by `appIcons.test.ts` against the circle rather than the square.

**Announcing something once** ([core-service](services/core-service.md#the-admin-announcement-shown-once-per-account))

- **A filter that REFUSES is a gate, and the difference is what the caller learns** - three reasons, one `null`, on purpose.
- **A range with NO BOUNDS must not read the value it would have compared** - ask whether the discriminator is needed before demanding it be valid.
- **"Once per account" is a SERVER ROW or it is nothing** - and that row answers one question, "has this account seen X", never "is this account current".

## The public head, and the two adapters -> [frontend/seo](frontend/seo.md), [nginx](infrastructure/nginx.md)

- **A crawler on this site sees NO content** - Googlebot renders as an anonymous visitor, so it renders the login screen. The injected `<head>` is the whole indexable surface, the SITEMAP the entire link graph. [seo](frontend/seo.md)
- **Cloudflare REPLACES the body of an origin 5xx with its own 16-byte page**, so an `error_page` without `=` reaches nobody behind the tunnel. [nginx](infrastructure/nginx.md)
- **nginx does not TRUNCATE an oversized upstream header, it 502s** - SvelteKit's `Link: rel=modulepreload` is ~7.5 KB against a 4 KB default. [nginx](infrastructure/nginx.md)
- **A deploy being green proves the containers started, never that the site ANSWERS** - probe each SHAPE of path. [cicd](cicd.md)

## The edge -> [cloudflare-edge](infrastructure/cloudflare-edge.md), [nginx](infrastructure/nginx.md)

`edge` = [cloudflare-edge](infrastructure/cloudflare-edge.md), `nginx` = [nginx](infrastructure/nginx.md).

**Who owns a header**

- **nginx owns EVERY response header; the edge adds none** - the edge has no representation in git, so no review, test or deploy can see it change. [edge](infrastructure/cloudflare-edge.md)
- **A header two layers can set belongs to exactly ONE of them** - two `Access-Control-Allow-Origin` is malformed to every browser, and it fired only for the origins the allowlist RECOGNISES, so it broke local development and worked in production. `proxy_hide_header` before `add_header`. [nginx](infrastructure/nginx.md)
- **A policy that must be restated per block is declared ONCE and included** - `add_header` REPLACES the inherited set, and verbatim copies do not stay equal. [nginx](infrastructure/nginx.md)
- **A refusal expressed as a THROW is a 500, not a refusal** - `callback(null, false)`, never `callback(new Error(...))`. A policy layer that cannot say "no" without saying "broken" reports a fault the system does not have. [nginx](infrastructure/nginx.md)

**CSP, and why its failures do not look like CSP**

- **A second CSP header can only REMOVE permissions, never grant one** - the effect is the INTERSECTION, so a rule added to "loosen" a policy asserts the opposite of its only possible effect, and deleting it is provably safe. [edge](infrastructure/cloudflare-edge.md)
- **`*` matches NETWORK SCHEMES only** - never `blob:`, `data:` or `filesystem:`, so `connect-src *` is stricter than `connect-src 'self' blob:` for the case that matters. [edge](infrastructure/cloudflare-edge.md)
- **A permission to DISPLAY is not a permission to READ** - the half that is allowed is the visible half, so the feature looks alive and does nothing. [edge](infrastructure/cloudflare-edge.md)
- **A CSP refusal is indistinguishable from an ordinary failure, BY DESIGN** - only `securitypolicyviolation` names the directive, so build the probe on that event or it reports the theory it was written with. [edge](infrastructure/cloudflare-edge.md)
- **An allowlist is a DESCRIPTION OF THE CODE**, so it has a test that fails when the code calls a host it does not name. [edge](infrastructure/cloudflare-edge.md)

**Topology**

- **The account is the unit of audit, not the ZONE - and a second hostname can name the same destination.** The tunnel INGRESS table is the only listing that shows it; a DNS listing shows names alone. [edge](infrastructure/cloudflare-edge.md)
- **The single public entry point is also a single point of DISCONNECTION: a frontend redeploy cuts every proxied WebSocket at once.** So the reconnect ladder is exercised fleet-wide by every deploy, and **any measurement window that straddles a deploy explains its own fallout**. [WP-RECONNECT-1](frontend/modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it)
- **Configuration assembled as TEXT is validated in the build, or it is validated by the outage** - `RUN nginx -t` costs a red pipeline instead of a site that will not start. [nginx](infrastructure/nginx.md)

## Server-side fetches -> [chat-delivery](services/chat-delivery.md), [nginx](infrastructure/nginx.md)

The link-preview pipeline, the SSRF guard, the favicon cascade and the undici seam are on
[chat-delivery](services/chat-delivery.md); the avatar proxy on
[core-service](services/core-service.md#the-avatar-proxy).

**Deadlines**

- **A call with NO deadline cannot fail, which is worse than failing** - `fetch` has no default timeout anywhere, so every degradation written for that call is dead code and the page never finishes. **The budget belongs to the REPOSITORY, not to the call**: one constant, every outbound path. [chat-delivery](services/chat-delivery.md)
- **A stated budget that is not the one that FIRES is a comment, not a rule** - set every mechanism that can enforce it from one constant, and check the layer underneath has no default of its own. [chat-delivery](services/chat-delivery.md)

**Caching**

- **Only an ANSWER may be cached** - "the upstream says there is none" and "I could not reach the upstream" must never reach the same cache, and dressing the second as the first is a lie that outlives the incident. [core-service](services/core-service.md#the-avatar-proxy)
- **A key naming a CONTENT may be cached for ever; a key naming an IDENTITY may not** - and **Cache Storage ignores `Cache-Control` entirely**, so a second store over the same bytes is a freeze, not a cache. [core-service](services/core-service.md#the-avatar-proxy)
- **A cache that only remembers SUCCESSES amplifies every failure** - the absent case is usually the common one, so a miss that is not remembered is a request repeated for ever, per render, per viewer. [core-service](services/core-service.md#the-avatar-proxy)

**Answering for someone else**

- **Our credentials are not the USER's, so our upstream's 401 must not become theirs.** [core-service](services/core-service.md#the-avatar-proxy)
- **A lookup that FAILED returns "I do not know", never the text it would have displayed** - rendering a placeholder is the CALLER's decision. [arch](frontend/architecture.md#a-synchronous-unknown-placeholder-is-indistinguishable-from-an-answer)
- **An optional decoration that cannot be fetched DEGRADES, it does not error** - and the LOG is where the causes are told apart, never the status code. [core-service](services/core-service.md#the-avatar-proxy)

**Fetching a stranger's bytes**

- **`new URL(href, base)` RESOLVES hostile input rather than throwing** - `javascript:` and `data:` survive as absolute URLs, so a try/catch around the parse guards nothing. Check the SCHEME. [chat-delivery](services/chat-delivery.md)
- **An `<img src>` at a third party inside an E2E conversation tells that host who read and when** - and the proxy is also the only thing checking the bytes are an image. [chat-delivery](services/chat-delivery.md)
- **Serving a file is not serving it CORRECTLY** - check the header, not the status code (nginx `mime.types` has no `.mjs`). [nginx](infrastructure/nginx.md)
- **A safety check with an unrelated failure mode needs its OWN endpoint**, not a field bolted onto an existing response - and a check the upstream gives no cache guidance for still needs an explicit TTL of its own (WP-SAFELINK-1). [chat-delivery](services/chat-delivery.md)

## Service-to-service calls -> [api-surface](protocols/api-surface.md#internal-cross-service-calls)

- **An internal call carries the callee's GLOBAL PREFIX, or it is a 404 nobody reads** - fix it at the seam (`internal/service-urls.ts`), so it is not the caller's to write. Putting `/api` in the compose file fixes the deployment and leaves the code's defaults wrong. [api-surface](protocols/api-surface.md#internal-cross-service-calls)
- **A convention applied in two places out of three is the worst state a convention can be in** - the two correct ones are what make the third invisible, because every reading of "how do we call another service here" returns a correct example. [api-surface](protocols/api-surface.md#internal-cross-service-calls)
- **A best-effort `.catch(warn)` is designed for a TRANSIENT fault and will hide a PERMANENT one for ever.** A route that never once worked is indistinguishable from a service briefly down; the only instrument that finds this class is the CALLEE's log, read over a window in which the path is known to have run. [api-surface](protocols/api-surface.md#internal-cross-service-calls)
- **A second copy of a send is a second CONTRACT, and only one of them will be maintained** - a shared payload builder is not a shared path. Test the message that actually leaves the process, through the real caller. [chat-delivery](services/chat-delivery.md)
- **A URL IS NOT AN ADDRESS UNTIL THE CREDENTIAL FITS IT.** A route's guard is part of its contract, so a service calling a route written for USERS is a permanent 401 whatever it puts in the path - `HeaderAuthGuard` wants headers only Nginx mints, and a container has none and must not forge them. Fixing a wrong prefix and stopping there leaves the call reaching the wrong door correctly. [api-surface](protocols/api-surface.md#internal-cross-service-calls)
- **A STUB THAT ANSWERS ANY URL TESTS EVERYTHING EXCEPT WHAT A CLIENT CALL GETS WRONG.** Six tests around one internal call stayed green while it answered 401 on production, because `fetch` was mocked by status and body and never by ADDRESS. Assert the URL, or the suite is testing the parser. [development](development.md)
- **A GUARD THAT STOPS FAILING OPEN STARTS REPORTING WHAT WAS ALWAYS BROKEN** - and it looks like a regression on the day it lands. Read the new failure as the measurement it is, and expect it to name a second fault under the first. [api-surface](protocols/api-surface.md#internal-cross-service-calls)

## Contracts the compiler does not check -> [development](development.md)

Every unchecked seam - Tauri command names, plugin ACLs, `push_context.json`, `mlsWorkerProtocol.ts`,
`LoginErrorCode` - is enumerated on [development](development.md#contracts-the-compiler-does-not-check).
What must not be forgotten between the pages:

**Seams nothing compiles**

- **A cross-process contract is only as good as its test** - pin the PATHS as well as the field names, or a writer on one OS fills a directory nothing reads. [dev](development.md#cross-language-boundaries)
- **`Log.d` takes a TAG then a payload, and one argument makes the sentence the tag** - it prints `[[TAG] ...]`, which no reader and no log rule expects, and only an exact-match classifier ever notices. [dev](development.md#cross-language-boundaries)
- **A payload field with no reader-side check drifts in BOTH directions, silently** - pin it with a source-reading test each way (`channelPushFields.test.ts`, twin of `fcmCacheFields.test.ts`). [channel-encryption](protocols/channel-encryption.md)
- **A plugin in `Cargo.toml` is not a plugin the app may CALL** - Tauri v2 gates COMMANDS behind `capabilities/`, and an ungranted one ships and rejects on a real device. EVENTS are not gated. [mob](frontend/mobile.md)
- **A query builder's output is unverified until a real Postgres sees it** - and where a test cannot reach, the DEPLOY LOG is the test. [dev](development.md#things-that-look-type-safe-and-are-not)
- **A connection pool makes `BEGIN` and `COMMIT` two different conversations** - a statement is the largest unit of atomicity available. [mob](frontend/mobile.md)
- **Two frontend builds writing `build/` at once ship an app that cannot boot, and every gate is green** - `beforeBuildCommand` IS `bun run build`. [dev](development.md#scripts)
- **A ROUTING TABLE SPELLED AS A STRING PREFIX AT THE CALL SITE IS A CONTRACT NOBODY DECLARES**, and it fails by dropping - not by throwing. Both socket clients routed to `handleChannelEvent` on `type.startsWith('channel.')`, written before the `workspace.*` family existed, so four events the server publishes, the gateway forwards and the handler has branches for were delivered and discarded, in two places, for months. The predicate lives in ONE module both clients ask (`channelEventTypes.ts`) and is asserted against the types the server really publishes. **And a typed frame that reaches no branch LOGS** - a silent default is what let this survive: it had a comment saying it was silently ignored. [chat](frontend/modules/chat.md)
- **A route's REACHABILITY is decided by registration order, and registration order is the module import list** - so `users/announcement` in a module imported after `UsersModule` is captured by `users/:id` and answers 404 for a user of that name. Reordering the list is not the fix: it makes correctness depend on a list nobody reads. A THIRD segment cannot collide whatever the order, which is a property of the path. The evidence is the callee's own `RouterExplorer` lines, never the caller's status. [core-service](services/core-service.md#the-route-was-unreachable-from-the-day-it-shipped---found-2026-08-19-on-prod)
- **A SOFT-DELETED ROW STILL OCCUPIES EVERY UNIQUE SCOPE IT NAMES** - a plain `deletedAt` column is not a `@DeleteDateColumn`, so an ordinary `findOne` returns the tombstone and a partial unique index does not exclude it. Release the scope in the SAME write as the tombstone, or the next occupant is handed the dead row. [channel-encryption](protocols/channel-encryption.md#three-more-from-driving-a-real-salon-through-its-whole-lifecycle)
- **A GUARD MUST READ THE FACT THE CALLER KNOWS, NOT THE ROW THAT ANSWERS A DIFFERENT QUESTION** - a step that runs deliberately BEFORE a save cannot be gated on what that save is about to write. Pass the intent; re-deriving it from the row refuses exactly the path the step exists for. [channel-encryption](protocols/channel-encryption.md#three-more-from-driving-a-real-salon-through-its-whole-lifecycle)
- **ADDING A SECOND DISCRIMINATOR MEANS RE-VISITING EVERY PREDICATE THAT TESTED THE FIRST** - `distributionChannelId` beside `distributionWorkspaceId` left the one exclusion that keeps a distribution group out of the conversation list testing half the population. Enumerate the READERS of the column, not the writers of the new one. [channel-encryption](protocols/channel-encryption.md#three-more-from-driving-a-real-salon-through-its-whole-lifecycle)
- **A DESIGN CHANGE FALSIFIES THE SENTENCES THAT DESCRIBED THE OLD ONE** - grep the message catalogue for the behaviour you just removed, in both locales. `chat_channel_admins_access_all_hint` survived the change that made it false. [channel-encryption](protocols/channel-encryption.md#three-more-from-driving-a-real-salon-through-its-whole-lifecycle)
- **A handler's path is COMPOSED, so writing the controller's own prefix again registers it one segment too deep** - `@Controller('channels')` + `@Get('channels/:id/x')` is `/channels/channels/:id/x`, which is not a type error, not a lint error, and leaves every unit test of the method green while no URL reaches it. Assert the COMPOSED path from `PATH_METADATA`, and assert the defect CLASS (no handler repeats the prefix) rather than the instance. [channel-encryption](protocols/channel-encryption.md#found-on-production-and-only-there-the-three-routes-were-registered-one-segment-too-deep)
- **Returning `null` from a Nest handler sends an EMPTY BODY, so the caller's `res.json()` throws on the ORDINARY case** - and a parse error is not the same fact as "nothing to show". Wrap the answer, so the absence is a value the wire can carry. [core-service](services/core-service.md#the-route-was-unreachable-from-the-day-it-shipped---found-2026-08-19-on-prod)

**Classify at the throw**

- **A distinction carried in PROSE is a distinction exactly ONE call site will make** - the classification belongs at the throw, as a TYPE. [media-service](services/media-service.md)
- **When the throw is on the other side of HTTP, the type is a `code` IN THE BODY** - and a list of substrings hides both its own duplicates and which of them this client can even produce. [social-service](services/social-service.md)
- **A status parsed back out of a SENTENCE is a status that was discarded** - carry it as a field. [auth](frontend/modules/auth.md#a-status-parsed-back-out-of-a-sentence-is-a-status-that-was-discarded)
- **A `catch` that has to recognise its OWN throw is too wide** - the check belongs above the `try`, and the branch disappears rather than being typed. [backup](frontend/backup.md)
- **Never let a capability probe swallow its own failure, and never branch on an error MESSAGE.** [dev](development.md#things-that-look-type-safe-and-are-not)
- **One surface handling a case is not "the case is handled"** - enumerate the CONSUMERS of a seam, never just the ones that mention it. [auth](frontend/modules/auth.md#a-status-parsed-back-out-of-a-sentence-is-a-status-that-was-discarded)

**Finding every writer, and every failure**

- **Enumerate the WRITERS of the state, not the callers of the helper - then make the helper the only writer**, locked by a test that greps the source (WP-HISTGHOST-1). [chat](frontend/modules/chat.md#one-writer-for-a-conversations-retirement-retireconversation-wp-histghost-1)
- **Making a dead code path REACHABLE re-opens every check that path never had** - audit it as NEW code before enabling it. [chat](frontend/modules/chat.md#a-mutation-event-is-authorised-on-receipt-by-the-mls-sender)
- **A batch of maintenance jobs catches and logs PER JOB**, and a comment claiming subscribers are independent is not independence - isolation is a `try` per subscriber or it does not exist (WP-RETRANSMIT-1). [chat](frontend/modules/chat.md)

**Checks that measure nothing**

- **Carry the evidence that the WINDOW OPENED**, or a green result cannot be told from an unexercised one - the same rule makes a source-reading guard need a vacuity assertion. [testing-methodology](testing-methodology.md)
- **A CHECK THAT FAILS IS A CLAIM TO CHECK, NEVER A CHECK TO SOFTEN.** COMM-16 came back `false` on a row it expected gone, which reads exactly like a check written against a behaviour the product does not have - and the product was wrong: deleting a salon archived it after destroying its key. Relax an assertion only once the mechanism, not the verdict, has been read. [testing-methodology](testing-methodology.md)
- **A passing check that never armed its PRECONDITION measures nothing** - prove the state was set, and report `VACUOUS` rather than `PASS`. [testing-methodology](testing-methodology.md)
- **A SEARCH THAT WALKS OUTWARD FINDS A CONTAINER** - bound what the ancestor may hold, or the list gets counted as an item. COMM-4 read two cards off a store holding one row, on every run, because the five cards its own past runs had left made the nearest ancestor carrying this run's name the box around all six. And a rendered message is matched by its LITERAL parts, never rebuilt by filling a placeholder with a name from the harness: those name what the sidebar is searched by, not what the app renders. [testing-methodology](testing-methodology.md)
- **A PREDICATE THAT SAMPLES A MOVING VALUE REPORTS A FRAME, NOT A STATE.** `clearOverlays` - the rig's only isolation guarantee, run at the start of every check - decided what covered the screen by reading a dialog's `opacity`, which is `0` for the first frames of its fade-in. It answered "clean" with a full-size modal opening on top, and the cost was paid several gestures later as `no stable element` for a control plainly in the DOM. The repair is not a wait, which is the same race with better odds: ask whether the value has SETTLED. [testing-methodology](testing-methodology.md)
- **A CLICK IS NOT A SELECTION, AND A GESTURE SCOPED TO A SUBJECT MUST REFUSE TO RUN WHEN NOBODY NAMED ONE.** `realClick` proves a mousedown reached an element; whether the app then acted is a separate fact. COMM-12 clicked a community, the click did not take, the check swallowed the honest failure, and every later gesture ran on whatever was still selected - writing a Graine history rule onto a community the check had never heard of, with nothing failing because nothing was asked. Three repairs: **wait on the selector the next gesture will use** (a text match was satisfied by the line the app logs on creation), **take the proof of a selection from the app itself**, and **gate the one choke point** every scoped write passes through with a ledger of what was PROVEN open. In the check: the step that establishes the subject of the steps after it must be fatal. [testing-methodology](testing-methodology.md)
- **A PANEL'S LIFETIME BELONGS TO WHOEVER OPENED IT**, and a fix aimed at the gesture that failed leaves the class standing - five of twelve call sites had dropped the close, and the previous fix had gone to the single gesture that broke. Scope it (`inPanel`) so it cannot be forgotten, and make the blocker NAME itself: `DIV.fixed z-[280] ...` identifies nothing. [testing-methodology](testing-methodology.md)
- **A BACKSLASH BELONGS TO WHOEVER PARSES THE STRING LAST, AND A TEMPLATE LITERAL IS NOT THAT PARSER.** Code authored here to run elsewhere - a page-side expression, a pattern for `RegExp` - has its escapes eaten on the way out: `\r` leaves as a newline (loud), `\s` leaves as the letter `s` (silent, and asks a different question under a recorded verdict). Write it `String.raw`, and confirm by RUNNING it. [testing-methodology](testing-methodology.md)
- **A distribution is not a diagnosis** - before blaming a cause, check whether the mechanism that would have prevented it is already running, by running the app's OWN transform over a representative input. [storage-forecast](infrastructure/storage-forecast.md)

## Mobile and native -> [frontend/mobile](frontend/mobile.md)

Push transports, the App Group, the NSE, the decrypt ladder and the update target are all on that
page. `mob` = [mobile](frontend/mobile.md), `auth` = [auth](frontend/modules/auth.md).

**Where the platform is not the web**

- **A gate inside a component's own `onclick` is dead code wherever something else already owns the event** - gate the ONE function both paths call. [mob](frontend/mobile.md)
- **`fetch` is not `fetch` in the WebView**: the routing rule names what the plugin CAN do, never the exceptions. [mob](frontend/mobile.md#fetch-is-not-fetch-inside-the-webview)
- **A relative `/api/` path is dead on mobile, and it fails as a SUCCESS** - 200 with an HTML body. [mob](frontend/mobile.md#a-relative-api-path-is-dead-on-mobile-and-it-fails-as-a-success)
- **A WebView has no download manager**: `<a download>` is a silent no-op that still "succeeds". [mob](frontend/mobile.md)
- **An app extension has its own data container** - the App Group is the only shared storage. [mob](frontend/mobile.md)
- **A native thread has no Java frames**, so `FindClass` reaches framework classes only. [mob](frontend/mobile.md)
- **Edge-to-edge is not guaranteed by `env(safe-area-inset-*)` alone** - call `enableEdgeToEdge()` explicitly. [mob](frontend/mobile.md)
- **A CSS custom property consumed at two nesting depths applies its correction twice**; delete the second consumer. [mob](frontend/mobile.md)
- **A plain system-browser launch is an ORPHANED activity on Android** - a Custom Tab shares the app's task. [mob](frontend/mobile.md)

**What a lock, a boot or a push can do to a fact**

- **Work guarded by one lock is already serial - giving it a thread each only adds the fight.** Serialising it adds no latency. [mob](frontend/mobile.md)
- **A lock timeout is not a domain answer.** Any predicate that can FAIL TO LOOK needs a third value, and `UNKNOWN` reaches no recovery. [mob](frontend/mobile.md)
- **A dependency can make your process start in a state you never designed for** - read the MERGED manifest. [mob](frontend/mobile.md)
- **A destructive repair must be gated on knowing the state is really broken**, or a temporary condition becomes a permanent loss. [mob](frontend/mobile.md)
- **A destructive control exposed to the user needs an ALLOWLIST of what it may touch, not a denylist.** [mob](frontend/mobile.md)
- **Background decrypt applies no commit**, so a silent commit push leaves the next message unreadable - that is the epoch gap. [mob](frontend/mobile.md)
- **A decision reachable from the CLEARTEXT push fields must never sit behind the decrypt ladder.** [mob](frontend/mobile.md)
- **What removes a notification must key on what the POSTER wrote - and on iOS there are two posters.** [mob](frontend/mobile.md)

**Connections that stop, and never start again**

- **A pause must have a symmetric resume, and a circuit breaker must never cut the wire to its own reset.** [auth](frontend/modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it)
- **A resumption condition must be one EVERY client can emit**, or the breaker is a permanent kill for whoever cannot. [auth](frontend/modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it)
- **A repeated transport failure is not an answer and may never end a retry loop** - only a proof may. Unbounded in COUNT, bounded in RATE, one rung armed at a time. [auth](frontend/modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it)
- **A reschedule issued inside the guard that forbids it is a no-op that logs success.** [auth](frontend/modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it)
- **An app can be fully alive on HTTP and dead on its socket**, so "the network works" is never evidence the connection does. [auth](frontend/modules/auth.md)
- **`getCurrent()` answers "the last deep link this PROCESS was handed"**, so every re-read is deduplicated - and **state whose job is to survive an event must not live where that event destroys it**. [mob](frontend/mobile.md)

**Shipping**

- **A Play-signed install and the GitHub-signed APK cannot update each other**, so the update target is a RUNTIME fact. [mob](frontend/mobile.md#where-an-update-comes-from)
- **`minClientVersion` is the only thing that interrupts a user now** - raising it before the store rollout has landed locks everyone out. [legacy-compatibility](legacy-compatibility.md)
- **A path restriction written for iOS has NO effect on Android**, so the claim lists are GENERATED from one source. [mob](frontend/mobile.md)
- **Only user-VISIBLE native strings stay French**; everything read while debugging is English.
- **A no-op on one platform must say WHY** - "nothing to do" and "nobody has looked" are different, and only the first is evidence. [mob](frontend/mobile.md#android--ios-parity-and-where-it-is-actually-guaranteed)

**Parity is maintained BY CONSTRUCTION** - one shared file wherever the platforms can share one, a
test reading both trees wherever they cannot. Every parity defect ever found has been in
CONFIGURATION, never in code. Code audited 2026-08-03, configuration 2026-08-07; **do not re-audit
either** - the table is on
[mobile > parity](frontend/mobile.md#android--ios-parity-and-where-it-is-actually-guaranteed).

## Release and CI -> [cicd](cicd.md)

Signing, the bump script, the secrets and every compile-check trick are on [cicd](cicd.md).

- **A manual `workflow_dispatch` run of either release workflow is a pure compile check that ships nothing** - and the ONLY way to compile Swift/ObjC/Kotlin from Windows. Run both before believing any native change. [cicd](cicd.md#a-manual-workflow-run-is-the-only-native-compiler-available-off-macos)
- **A green run is not proof YOUR file compiled** - the iOS pbxproj is hand-maintained, so grep the log for `SwiftCompile` / `CompileC` on the file. [cicd](cicd.md#a-green-run-is-not-proof-that-your-file-compiled)
- **A credential is real in THREE places, not two** - a GitHub secret, `cd.yml`, AND the service's own `environment:` block in `docker-compose.prod.yml`. `.env` holding the value proves nothing about what Compose passes into the container (WP-SAFELINK-1). [cicd](cicd.md#github-secrets)
- **A generated file the repo COMMITS needs both halves or neither** - and worse than either half is one the FORMATTER also owns. Before ignoring any generated file, delete it and rebuild. [cicd](cicd.md#version-bump)
- **A generated file in git is a COPY of the truth, and a copy goes stale in silence** - ask which pipelines REBUILD it and which ship the committed one. Every pipeline shipping a client builds the artefact itself. [mls-wasm](frontend/mls-wasm.md#why-it-is-not-committed)
- **A SELECTIVE `git add` IS NOT ISOLATION WHEN A HOOK RE-STAGES.** The pre-commit hook sweeps the whole frontend and stages what it touched, so every dirty file in the tree rides along whatever you chose. The trap is the UNTRACKED one: on 2026-08-20 the hook committed a test file and the rasters it pins while its imported helper stayed untracked, and main's frontend check went red on a module that existed only on this machine. **Before committing, `git status` must be empty of anything you are not committing** - finish the stray work, commit it on its own, or stash it; deciding at `git add` time is deciding too late. [cicd](cicd.md)
- **A test file nobody EXECUTES reads as coverage on every review** - a green suite says only that the files it FOUND passed. Check the file COUNT, not the colour. [testing-methodology](testing-methodology.md)
- **"I cannot observe it" is a claim about the INTERFACES YOU TRIED** - enumerate what the mechanism WRITES (refs, journal lines, a running process) before concluding the one endpoint that refused was the only way to look. And note which absence proves nothing: a hidden ref namespace answers empty. [ecosystem-convergence](ecosystem-convergence.md#proving-a-pipeline-runs-without-the-api-that-would-have-said-so)

## Carte de la Vie Asso -> [carte-vie-asso](carte-vie-asso.md)

- **A published carte is the poster RESOLVED** (poster px + `stage`), never fractions and never a layout - the showcase decides nothing, so what it is not told it cannot copy.
- **Association identity joins LIVE; the displayed members are a SNAPSHOT**, so a roster edit republishes.
- **The two repos must agree on the FONTS**, or every measured box is wrong.

## Associations and agenda -> [social-service](services/social-service.md)

- **A second surface for an existing action mirrors the SERVER's rule, not the first surface's** - a `VALIDATE_EVENTS` holder had the right and nowhere to use it.
- **What a modal hides because it is redundant is a decision of the PAGE, never of `canEdit`.**

## Cotisations (Cercle) -> [cotisations](cotisations.md)

- **The tier XOR has ONE implementation** (`UserTagService.revokeSiblingTierTags`), and a tag revoke MUST be scoped to `issuingAssocId` or it is a cross-tenant IDOR.
- **A product entity carries `webhookSecret` and `/products/all` answers every logged-in user** - same lesson as `Channel.masterSecret`. `toSafeProduct` is the one seam, and a guard is a decorator nothing type-checks, so assert the metadata.

## Working in the Cercle repo -> `../le-cercle/AGENTS.md`

That file is the contract for THAT repo - the per-action guard, the 403 rather than a redirect, the
empty signing key, the rollback that throws a success value, the date model, the `bun:sqlite` and
migration traps, the run-time config rule. Read it there; re-copying it here only makes the two
drift. One thing it cannot say from inside: **a duplicate migration NUMBER is loud, not silent**
(`exit(1)` before applying anything) - but only once both branches have merged, so check the highest
number on `main` before naming a file. Its CI is verified running:
[ecosystem-convergence](ecosystem-convergence.md#proving-a-pipeline-runs-without-the-api-that-would-have-said-so).

## Calls, and their record -> [call-service](services/call-service.md#the-call-record)

- **A failure seen in HALVES is attributed by the one witness that sees both, or not at all** - the SFU is that witness, so its record carries what separates the causes it cannot itself distinguish, one line per socket.
- **`duration_ms` alone cannot say whether a call happened** - it is read next to `connected_ms`, and `connected_ms=-` is a STATEMENT, never a missing value.
- **A disposition is set ONCE and the first cause wins** - recording the last event reports the consequence and hides the cause.
- **Counts at the END of negotiation, never a line per candidate** - and build the terminal ICE line out of the same helper as the record so the two cannot drift.
- **A per-device guard on a FAN-OUT reports a fleet fault when the fault is ours** - check the one thing every device depends on ONCE, before the loop, and never `break` out of a fan-out that returns a count.
- **Dropping an `RTCPeerConnection` is not CLOSING it** - webrtc-rs holds the TURN allocation until told to let go, and a "session end" line emitted while it is live states an end that has not happened.

## Presence, in the gateway -> [chat-gateway](services/chat-gateway.md#presence)

- **The presence key is per DEVICE and every event that removes it is per CONNECTION** - two tabs are one device, so any deleter must discount its own connection and check for survivors. `AppState::remove_session` / `has_other_sessions` are the only two forms of that question; a third call site writing its own is the bug.
- **A connection is identified by its `conn_id`, never by `is_closed()`** - an aborted send task still reports `false` until the runtime drops its receiver.

## Sessions, in every app -> [sessions](sessions.md)

Settled 2026-08-04 (WP-SESS-1, WP-SESS-2), SHIPPED in all four apps. Read [sessions](sessions.md)
before touching any login, cookie or rotation.

- **A cookie whose content IS the identity it claims is not a credential, it is a form field.**
- **A replayed rotating token is TWO holders of one cookie** - revoke the session, with a grace window, and settle the race in ONE conditional `UPDATE`.
- **An empty key can fail OPEN or CLOSED and you cannot guess which.** Decide explicitly.
- **Rotation makes DURABILITY part of the protocol** - force the write where the rotation happens and AWAIT it; on Android the cookie jar reaches disk only on `CookieManager.flush()`.
- **A dead session is an ANSWER** - never retry the request anonymously, or "you are logged out" renders as "there is nothing here". Reach the verdict in ONE place.
- **A one-shot announcement and a late subscriber are a RACE** - replay the verdict to whoever registers after it, because a fallback never does everything the real handler does.

## Object storage, and deleting infrastructure -> [docker](infrastructure/docker.md)

- **A COUNT is not a COMPARISON** - compare the KEY SETS, both directions. Ours held 306 against 200 and was still missing five.
- **A rollback window on an object store is a window during which DELETED user content stays readable** - weigh that against what the window buys; it is not free time.
- **The database cannot tell you what REFERENCES a media object** - an attachment id travels inside the ciphertext, so "is this blob still needed" is answered from the migration record, never from a query.
- **Before deleting a volume, MOUNT it and ask it** - a throwaway container over the volume costs 30 seconds and is the only measurement that postdates the decision.
- **A volume outlives the compose file that named it** - every deleted service owes an explicit `docker volume rm`, and there is usually more than one.

## Shared gotchas -> [development](development.md), [cicd](cicd.md)

Environment and tooling traps that belong to no one subsystem. Each cost a run.

- **Postgres stores UTC and the prod host is `Europe/Paris`**, so a DB timestamp is two hours behind the wall clock a test wrote down. Both are correct - convert, never "fix" the server clock. [testing-methodology](testing-methodology.md#environment-traps-that-read-as-application-bugs)
- **A Python write in TEXT MODE rewrites every line ending on Windows, and the diff hides it.** [dev](development.md#editing-files-from-a-script-on-windows)
- **Android Rust compiles from Windows** - the only local check of `#[cfg(android)]` code, and it proves compilation only. [dev](development.md#compiling-android-rust-from-windows)
- **A live credential is not a debugging input** - reach for the observable, not the secret.
- Bash-tool commit messages: a heredoc or `git commit -F file`, NOT a PowerShell here-string.
- Backend lint needs `npm install` in the app dir (bare `oxlint` / `oxfmt` + repo-level configs).
- The pre-commit hook sweeps the WHOLE frontend and re-stages - isolate unrelated dirty files first.
- Before push: `rm -rf apps/*/dist`, then `git pull --rebase --autostash origin main`.
- Commit signing is ON globally over SSH - all commits Verified, do NOT disable.
- **Never assert a wall clock in a test**; two isolated browser contexts = two devices.
- MiConnect 2FA remembers the device for 8 h; if the CAS page stalls after Esup Auth accepts, go BACK and reload rather than looping.
- Portail: SPA (`ssr = false`); `data-export/` holds PII, never commit. Sky UI French keeps accents and straight apostrophes.
