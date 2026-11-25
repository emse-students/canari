# The admission rule's fix-forward - the design, the slices, the gate

**What this page is.** The design of the P1 chantier that brings back, safely, the refusal #2815
shipped and the owner disarmed on 2026-10-31: a group conversation refusing an external commit by a
user who holds no leaf in its tree. The mechanism as it stands today (the verdict, the count, the
member-side card) is on [mls-protocol](mls-protocol.md#who-admits-a-new-person-2026-10-23); the
plan's entries are [the fix-forward](../backlog.d/p1-the-admission-rule-fix-forward.md) and the
later slices it links. This page is the only copy of the order and of the gate.

## The end state

A new person enters a GROUP conversation only through a member's Add - the owner's rule of
2026-10-23 ([principes](../../principes.md), principle 1: your messages are yours, and nobody joins
your conversation without a member letting them in). Concretely, all of these hold at once:

1. **No legitimate client produces the entry.** A device whose served tree holds no leaf of its
   account ASKS a member (the card "X veut rejoindre la conversation", step 2's) and waits; it never
   builds the external commit. In a 1:1 nothing changes: the peer IS the conversation, and the
   entry of its own peer stays legitimate (`direct-peer`).
2. **Every member refuses it, deterministically.** `judge_external_commit` (a function of the tree at
   the base epoch and the commit alone) answers `Uninvited`, and the commit is not merged - on every
   member device, the same verdict at the same epoch.
3. **A refusal leaves nothing permanent.** It is per account, never device-wide, and lifted by a
   person (a member's Add) or by a fact (the group moving past it) - the unfreeze path.
4. **A refusal never drops a frame.** It may stop a recovery; it may not ACK a conversation's
   messages away.
5. **No member can split or freeze the group with it.** Every client allowed to connect refuses the
   same commit (the floor is the refusing build), so an older client merging it while its peers
   refuse is impossible, and a member enrolling a second account to freeze a conversation meets a
   refusal that freezes nothing (3 and 4).

## The gate that lifts the refusal

> A conversation may refuse an entry no member made only once nothing legitimate produces one.

"Nothing legitimate produces one" is a TEST and a MEASUREMENT, both named:

- **The test** (slice 3): a client at the emission build, in a GROUP conversation, on a served tree
  that answers `no-leaf-of-user`, builds no commit and asks a member - pinned on `externalJoin` and
  `requestReAdd`, one case per seat reading that reaches the door (`unhonoured-seat`, `not-pending`,
  `no-device-row`), and in `mls-core` by the three legitimate producers of `admission_policy.rs`
  (each asserting today that the entrant's standing is `NoLeafOfUser`).
- **The measurement** (read on production, read-only): once `minClientVersion` is the emission build
  and that floor has served **14 days**, BOTH words are zero for a group conversation since the
  floor was raised:

  ```sql
  -- (a) The entrant's own word: no client at the floor emitted a group entry.
  SELECT kind, count(*) FROM uninvited_entries
  WHERE kind IN ('entrant-unhonoured-seat', 'entrant-not-pending', 'entrant-no-device-row')
    AND "firstSeenAt" >= '<the day the floor was raised>'
  GROUP BY kind;

  -- (b) The members' word: no `new-person` entry of a group conversation, once the pre-038 link
  -- seats (their pair list, matched on group and entrant user) are subtracted.
  SELECT count(*) FROM uninvited_entries u
  JOIN dm_groups g ON g.id = u."groupId" AND g."isGroup"
  WHERE u.kind = 'new-person' AND u."firstSeenAt" >= '<the day the floor was raised>';
  ```

  (a) alone is NOT the gate: an entrant's report is at-most-once per session and never retried, so
  a lost report reads as zero. (b) is what a lost report cannot hide - every member device reports
  the same entry - and (a) is what names the path when (b) is not zero. Zero rows on both is the
  gate. A row of (a) is a legitimate path the emission side missed (its kind names the seat reading
  to close next); a row of (b) not explained by (a) or by the pre-038 list is either a client that is
  not ours or a legitimate path neither word names - the refusal stays disarmed until it is read.
  `entrant-direct-peer` and `direct-peer` are not in the gate - a 1:1's own peer is never refused.

Every `new-person` row a MEMBER writes after the re-arm is then, by construction, an entry no client
at the floor made - the population the refusal exists for - except the pre-038 link seats, which are
subtracted by their pair list ([mls-protocol](mls-protocol.md#the-count-is-a-table-uninvited_entries-migration-053-2026-11-17)).

## The slices, in order

Each slice is one pull request (or one reading) that moves toward the end state with no step back,
and says what it proves.

| # | Slice | Proves | Version |
| --- | --- | --- | --- |
| 1 | **The entrant's own word**, classified at the throw (built 2026-11-25, below) | which legitimate path produces each entry, and how often; which member `new-person` rows a client at this build explains | 1.8.1 |
| 2 | **The member side, read and floored** - the card for a seat that is not an ask (built 2026-11-19); its rig reading on a constructed state; `minClientVersion` raised to it once both stores serve it | every client allowed to connect can answer an ask, so an asker never waits for ever | 1.8.1 |
| 3 | **The emission side**: `no-leaf-of-user` in a group conversation asks a member, never self-joins ([entry](../backlog.d/p1-admission-fix-forward-the-emission-side.md)); then its floor | the gate's TEST; after 14 days at its floor, the gate's MEASUREMENT | 1.9.0 |
| 4 | **The unfreeze path**, designed here first ([entry](../backlog.d/p1-admission-fix-forward-unfreeze-and-never-drop.md)) | a refusal is lifted by a person or a fact, per account | 1.10.0 |
| 5 | **Never drop frames, the floor at the refusing build, the re-arm** behind the gate ([same entry](../backlog.d/p1-admission-fix-forward-unfreeze-and-never-drop.md)) | the end state | 1.10.0 |

Slices 1 and 2 have no dependency on each other. Slice 3 needs slice 2's floor (an older member asks
nobody). Slice 5 needs slice 3's measurement at zero and slice 4 built.

## Slice 1 - the entrant's own word (built 2026-11-25)

**The gap it closes.** The count members write (`uninvited_entries`, migration 053) says THAT an entry
happened and how each member classified it (`new-person`, `returning`, `direct-peer`,
`unvouched-device`). It cannot say WHICH of the three legitimate producers made it - a skipped
KeyPackage, a user whose only device was revoked and swept, an only leaf evicted on a standing seat
- because a member sees only the commit. The entrant knows, at the moment it decides to commit. A
distinction carried in prose by a reader is one only that reader makes: it is classified where the
decision is taken, as a type.

**The three answers, from the engine.** `external_join_is_a_further_device -> bool` (whose `false`
meant two different things) is now `MlsManager::external_join_standing -> ExternalJoinStanding`
(`welcome.rs`): `OwnLeaf`, `FurtherDevice`, `NoLeafOfUser`, read off the very GroupInfo the commit
is built on - the tree every member's `judge_external_commit` reads, so the entrant names the class
its members will put the commit in. WASM and Tauri hand the word (`own-leaf`, `further-device`,
`no-leaf-of-user`) and `parseExternalJoinStanding` types it; an unknown word throws, which the join
already reads as "the tree could not be read" and builds nothing. This is also the predicate slice 3
decides on.

**Nothing about the join changes.** `externalJoin` under `asAFurtherDevice: 'ask'` (the conversation
door) still refuses a further device and still joins on the other two. The standing is read on EVERY
conversation join, whatever the caller asked (a key group is exempt: an external commit is how every
member enters one) - so no call site can forget it, and a caller that shares another's flight gets
it. That covers the **D1 further-device self-join** (`requestReAdd` after a `stored` answer,
`welcomeOwed: 'ask'`): the fresh base it builds on may no longer hold the account's other leaf,
and then it IS an entry no member made (review of #4078). A join ACCEPTED on `no-leaf-of-user`
returns `{ joined: true, enteredWithNoLeafAtEpoch }`. `requestReAdd`, the only
caller that knows the conversation's kind and the seat reading that opened the door, reports it once
per session (`reportOwnUninvitedEntry`, `uninvitedEntry.ts`) under the entrant's own kind:

| `kind` | Read from | The producers it can be |
| --- | --- | --- |
| `entrant-direct-peer` | the row is a 1:1 | the peer whose KeyPackage was skipped at creation; a peer whose only device went - legitimate for good |
| `entrant-unhonoured-seat` | group; this device's row `pending`, nobody owes it a Welcome | a seat whose KeyPackage an Add skipped; a pre-038 link seat; a row demoted out of `active` |
| `entrant-not-pending` | group; this device's row `active` | this device was in the group and lost its only leaf while its row stood (the evicted-only-leaf path) |
| `entrant-no-device-row` | group; the account seated, this device without a row | a new device of a user whose every leaf went (the revoked-and-swept path) |

The group kinds name the seat reading as it is - a fact the device holds - never a guess at the path;
the right column is what each can be.

**Same table, same key, so the two words pair.** `POST mls/uninvited-entry` takes the four
`entrant-*` kinds; for them the server takes the `entrant` from the authenticated caller, never from
the body - a device speaks only for itself. The row's key is `(group, entrant, epoch, kind)`, the
members' own, so a member's `new-person` row and the entrant's row for the same entry share
`(group, entrant, epoch)`. No migration: `kind` is `VARCHAR(32)`, the longest word is 23. The rows
hold nothing a member's row did not (the entrant's shortened user id and device id), so the
retention, the erasure and register entry C13 cover them unchanged. A server older than this client
counts the word as `kind=invalid` - which cannot happen in practice: production is deployed with the
stable before any store serves the client.

**Its reading** - owed once the stable carrying slice 1 has served 14 days of production, read-only,
two statements:

```sql
-- How often each legitimate path fires, by the entrant's own word.
SELECT kind, count(*) FROM uninvited_entries WHERE kind LIKE 'entrant-%' GROUP BY kind ORDER BY 1;

-- Which member rows a client at this build explains: entrant_kind NULL is an entry no client of
-- this build reported (an older build, a lost report, or a client that is not ours).
SELECT m.kind AS member_kind, e.kind AS entrant_kind, count(*)
FROM uninvited_entries m
LEFT JOIN uninvited_entries e
  ON e."groupId" = m."groupId" AND e."entrantUserDevice" = m."entrantUserDevice"
 AND e.epoch = m.epoch AND e.kind LIKE 'entrant-%'
WHERE m.kind NOT LIKE 'entrant-%'
GROUP BY 1, 2 ORDER BY 1, 2;
```

Counts only go in the repository; the pairs stay on the server.

**A modified client can INFLATE the entrant's word**, never forge another device's: the server takes
the entrant from the authenticated caller, the reporter must be a member of the group, the route is
throttled per user, and a row lives 90 days. So (a) can be pushed UP, by a member about itself, and
the reading reads it that way: an `entrant-*` row with no member row on the same `(group, entrant,
epoch)` is a claim nobody saw - counted apart, never taken as a legitimate path; only a pair is.
Inflation can only hold the gate shut, never open it.

**What it cannot see, said so nobody reads it as a proof.** A report is at-most-once per app session
and never retried (the members' rule), so an unpaired member row is "not reported", never "not
legitimate", until slice 3's floor makes the legitimate emission impossible by construction. And a
client that is not ours says what it wants: the entrant's word sizes the honest paths, it never
excuses an entry.
