# The cross-client rig - open findings about the instrument itself

The reasoning and measurements behind the "harness itself" entries of [backlog](backlog.md), which keeps
a title and what is left. How a result earns belief is [testing-methodology](testing-methodology.md); how
to operate the rig is the [harness README](../../tools/cross-client-harness/README.md). Rule numbers below
are testing-methodology's.

## The phone's local debris cannot be swept (A1, 2026-09-08, still true 2026-09-21)

`sweepDismissed` (`archive/dismiss.mjs`) clears the client-side half of a deleted throwaway group - the
conversation a device keeps after the server row is tombstoned. It cannot reach a Tauri client: its reader
enumerates `indexedDB.databases()` for `CanariDB_<userId>`, and on `http://tauri.localhost` the only
database is `emoji-picker-element-fr`. Every pass ends with `A1 debris NOT swept: [dismiss] NO Canari
conversation store at http://tauri.localhost`.

The message is correct and the situation is not. The wording was written on 2026-09-08 because the
previous one read as a chooser declining, while a group deleted seven hours earlier was still in the
phone's sidebar under the PEER's name, which made `openConversation` ambiguous and cost NOTIF-1b three
verdicts. What closes it: the filter is `isGroupDebris(row.name)` and the phone's DOM carries the PEER's
name for such a row, so the name has to come from somewhere that still has it - the server's tombstoned
rows joined to what the phone shows - or the group is dismissed through the app's UI on A1 the way a user
would; failing the ROW when it created something on A1 is the least. P3 because nothing has cost a verdict
since the wording changed.

## No row can tell a healthy conversation from an epoch-forked one (2026-08-29)

Two production conversations sat forked one epoch behind for 24 hours, refusing 191 and 172 commits, while
every reading the rig takes was green (`data-ready="true"`, `syncing: 0`, `amber: []`). Found in the
server's refusal count. Reasoning:
[testing-methodology](testing-methodology.md#a-green-sidebar-tile-does-not-prove-the-group-is-not-epoch-forked).
The predicate is built (2026-10-04): `epochfork.mjs` compares, `archive/syncrows.mjs` `readEpochForks` reads
both halves, the client half is `window.__canariMlsEpochs()` (`mls-client/epochDevTools.ts`, installed by
`createMlsService`). Owed: the ROW - a MULTI-shaped row asking `readEpochForks` of a conversation it is NOT
using, run once on a build carrying the hook (older builds answer `unobservable`, never clean).

## A live socket dies in the middle of GRP-3 (2026-08-25)

Accepted as `PASS-DIRTY` by the user (*"on peut se contenter des pass dirty et passer a la suite"*): dirt
whose CLASS has been read and named may pass; unclassified dirt or dirt touching an assertion may not. This
one is a known shape with an unknown cause. `GRP --repeat 5` pass 1: ten rows, nine `PASS`, GRP-3
`PASS-DIRTY` on exactly `wsEvents: ["11:28:30.944 Network.webSocketClosed ..."]` on W1 (the remover), about
18 s after `removeMember` and ~12 s before the row ended, with every product assertion holding.

- **Why the known explanation does not apply**: rule 14 says a `goto` is a `Page.navigate` and a document
  replacement closes its own socket (`1006`), so `ignoringNavigation` forgives at most `documentsReplaced`
  closes. GRP-3 passes `navigate: false` everywhere and `ensureChat` clicks `text=Discussions` (a
  client-side route change, `Page.navigatedWithinDocument`), so the budget is 0 and this is a live socket
  dying. `wsidle.mjs` ruled out idle drops: W1 and W2 untouched for eight minutes produced zero closes.
- **Not known, and not to be guessed**: no console line accompanied it (READ's instance had `[WS]
  Disconnected. Code: 1006`), possibly because the app's own line is classified BENIGN; and whether the socket
  reopened was unmeasured because `watch.mjs` did not collect `Network.webSocketCreated` (rule 39 warns
  against reading that absence as a failure to reconnect). Rate: one in two recent runs. GRP-3's
  `PASS-DIRTY` of 2026-08-24 is a different cause (an `[OUTBOX] ... evicted` line from a stale bundle,
  closed by `8c248131`).
- **Instrument half DONE (2026-10-04)**: `report()` in `watch.mjs` records every completed handshake as
  `wsOpened` (dated, outside `clean`) and on the `timeline`. Owed, with the rig: `ws1.mjs` over GRP-3's
  sequence. A close at a fixed offset from `removeMember` belongs to the Remove path; at a fixed offset from
  the socket's own age it is a lifetime, which `wsidle.mjs` did not test (it watched a fresh socket).

## One named starting point at every granularity (asked 2026-08-25)

The user's requirement: *"Le preflight doit permettre d'executer chaque phase, voire meme chaque etape de
phase ou groupe d'etape en ayant le meme point de depart, independamment de ce qui a pu se passer avant"*;
*"Si le modal de pin s'affiche, tape le pin, s'il ne s'affiche pas, ne le tape pas, si on est sur la mauvaise
page, on peut recharger la page"*.

Measured 2026-08-25: `client()` guarantees NOTHING about the application (route, lock, modal). Of 23
sampled runners 8 assert something at their start and 15 assert nothing (`msg2`, `msg3`, `msg5`, `msg67`,
`msg8`, `msg9`, `msg10`, `type`, `del1`, `comm2`, `comm14`, `tab1`, ...); the preflight does the work ONCE
per run so the guarantee decays with every script after it. The contract to write: one exported,
idempotent entry point with an ASSERTED postcondition.

- The target state is named: on `/chat`, unlocked, no overlay, chat mounted, on the deployed bundle (the
  five facts `state.mjs` already reads).
- Cheap when already satisfied: read first, act only on what diverges, so it is affordable between step
  groups.
- The PIN is typed only if the gate is really up, detected structurally (`#encryption-pin`, or a button
  whose text is the `U+232B` glyph), never by searching page text.
- A wrong route on a web client is repaired by RELOADING - a logged REPAIR, not a fallback path. A1 is
  excluded by construction (`goto` re-locks the PIN and breaks Tauri's IPC into the old document;
  `chat.mjs` throws rather than let a caller do it).
- It says what it erased before erasing it; silent tidying would delete the only evidence of a defect in
  the previous check.
- Then every runner calls it and `run.mjs`'s preflight becomes that contract per device plus the run-wide
  checks: one definition, not two.

Why it is worth the conversion cost: rule 33 (changing what a check READS invalidates its green rows) does
not bite as usual, because the contract makes the state BEFORE the assertion known without changing what
any assertion measures. It removes a class the campaign already paid for - a check measuring behind a
modal, on the wrong route or behind a PIN gate - each of which produced a refusal or a hang, never a false
PASS.

## The bubble-action and observation helpers live in one runner

`archive/mut.mjs` carries `clickBubbleIcon` / `deleteBubble`, which locate a message's controls by their
lucide icon class and prove the click was RECEIVED. `search.mjs` did not adopt it and hand-rolled a confirm
click that pressed the wrong button for as long as the check existed (2026-08-22). The same split exists for
observation: `longestSilence` turns a hole in a client's timeline into a value, MUT's `finish()` attaches it
to every non-PASS verdict and no other phase does - the evidence rung 5's one SEARCH-2 miss needed. The
shared home is `chat.mjs`, which every phase consults, so moving a helper there invalidates MSG, TYPE, READ
and MUT under rule 33 - hours of ladder time for a refactor nothing is failing for. It waits for a moment
when the rig can be changed wholesale and the affected phases re-run together.

## Eight runners open IndexedDB by hand, and `idb.mjs` exists

`archive/idb.mjs` (2026-08-24) is the one reader that ITERATES the databases a profile holds, filters
`CanariDB_` while excluding `CanariDBMls*`, and never decrypts. It exists because `recon.mjs` takes the
FIRST database it finds (a coin toss on a two-account profile) and because reaching into `CanariDBMls*` by
prefix returns an empty result that reads like "nothing queued". Counted 2026-08-24, eight call sites carry
their own copy of the preamble (`del1`, `dismiss`, `grainestore`, `grp`, `identity`, `mlsdb`, `mut`,
`recon`); `del.mjs` is the only phase reading through the module. Converting a caller changes what it READS
and invalidates its green row (rule 33), so the copies stay while identical; the cost lands the day one
copy is fixed and the others are not (`recon.mjs`'s first-database bug). Same wholesale moment as above:
convert all eight, re-run the phases together.

## Re-registering the PIN verifier strands every other client silently (2026-09-04)

`pin_verifier` holds ONE row per user (verifier, salt, `registeredAt`) and minting a fresh device
re-registers it (here at 15:32:11, a device re-minted after a PIN reset). Nothing told the other clients:
W1 was unlocked, held its derived key in memory and kept passing checks for four and a half hours; at
20:15 TYPE-3 killed its tab and the correct PIN was refused with *"Votre PIN a ete change sur un autre
appareil. Recuperez vos messages avec votre ancien PIN."*

Two of the three parts may be correct (an unlocked session keeping its key is the design; the message is
accurate). What is not obviously correct is the SILENCE: a client whose vault material was replaced is one
reload from being locked out of its own history and is told nothing while it can still act; the signal
(`registeredAt` moved) exists on the server and reaches no one. The campaign cost: `newdevice.mjs` is the
HEAL-NEW runner and re-minting is its job, so every HEAL-NEW row strands W1 and W2 at their next unlock,
hours later in another rung, reading as a broken client. Its `WIPEABLE` allowlist protects the profile it
wipes and says nothing of the account-wide effect (a destructive control needs an allowlist of what it may
touch).

The repair, measured 2026-09-04 21:27: a stranded client is fixed by WIPING it. `bun newdevice.mjs
--device W1` removed the stale material, logged back in with no human step, answered the current PIN,
minted `...mtnci3lc-7mhd` and rejoined all four conversations plus the venue's distribution group by
external commit inside a second (the two `pending` seats on Repro Alpha and Beta went with it). It does not
touch `pin_verifier`. What the wipe costs is local history, already unreadable by the time anyone notices.
Owed: whether the same digits re-registered give a verifier the other clients accept (they did not here, so
the refusal is about material, not value); whether the "ancien PIN" recovery restores a stranded client's
MLS state or resets it; and whether production has ever put a real member in this state (`registeredAt`
beside each device's `lastSeen` answers it from the table).

## A check that dies mid-gesture leaves a file staged in the composer (2026-09-04)

MSG-4 stages a file, types a caption and clicks send; when it died between those steps the composer kept
the attachment, and the next runner's send carried the orphaned file. MSG-6 recorded `PASS-DIRTY` on `Erreur
envoi media: A requested file or directory could not be found`, an error about MSG-4's fixture in a check
that attaches nothing; both rows came back clean once MSG-4 stopped dying. The staging tray survives
navigation, so it is exactly the residue `openDM`'s docblock says a check may not inherit, and nothing
asserts it empty. What would close it: a staged-tray assertion in the shared entry point (like
`clearOverlays` at the top of `ensureChat`). P3 because the dirt is LOUD; the danger is the quiet version,
a valid file staged by a check that then passes.

## Two out-of-tree directories are both called `canari-harness` (2026-09-04)

| Reader | Specifier | Resolves to | Holds |
| --- | --- | --- | --- |
| `tools/cross-client-harness/names.mjs` | `../../../../canari-harness/` | `<parent-of-EMSE>/canari-harness/` | `names.mjs`, the three Chrome profiles, `results.ndjson`, `logs`, `test-accounts.json` |
| `tools/play-vitals/lib.mjs` | `../../../canari-harness/` | `<EMSE>/canari-harness/` | `play-console-sa.json`, `google-services.json`, `dumps`, AND a stale `names.mjs` |
| `infrastructure/local/pull-prod-dump.sh` | `$ROOT/../canari-harness/dumps` | `<EMSE>/canari-harness/` | the production dumps |

Both are live and neither is wrong alone; the trap is the shared NAME and that the directory the harness
does NOT read holds a decoy `names.mjs`, one `VENUE` line apart. Editing it changes nothing and says
nothing - which happened during the venue rename of 2026-09-04 (the edit landed, `grep` confirmed it, the
run kept printing the old value). Merging the directories or deleting the decoy is a one-off for the user
on the workstation (both hold credentials and Chrome profiles); the preflight prints `rig state:
<STATE_DIR>` on its first line.

## The wry bump that removes the abort (A1, 2026-09-14)

The defect is closed in this app: a URL `http::Uri` cannot parse used to SIGABRT the process from inside
wry's Android JNI frame; since 2026-09-15 `mobile::navigation::webview_may_load` (wired to `on_navigation`)
refuses it before the WebView starts
([mobile](frontend/mobile.md#the-app-owns-which-urls-its-own-webview-may-load)). wry 0.56.1
(`5ce72b0`, tauri-apps/wry#1772) replaces the `unwrap()` with a logging `match`. DONE 2026-10-08: tauri `2.12.1` / `wry 0.57.0` / `tao 0.37.1` with `plugin-store` 2.5.0, `plugin-opener` 2.7.0,
`plugin-http` 2.8.1, `plugin-fs` 2.6.0 (Dependabot #1491, #1596, #1597). wry 0.57.0's changelog lists #1772. The
vendored `tao` fork was DELETED, not rebased: `tao 0.37.1`'s `handle_intent` already filters a null `getType()`
(`.filter(|jstr| !jstr.is_null())`), the fork's one hunk. Measured on the Mi 9T with a debug APK: cold and warm
`fr.emse.canari://callback` deep link, a real Custom Tab sign-in, background/resume and `sweep.mjs --route /posts`
(0 overflowing) with no `NullPtr`, `NullPointerException`, `SIGABRT` or `panicked` in logcat; plugin-store wrote
`oidc-state.json` and `auth-native.json` and the callback read the state back. NOT exercised: `plugin-opener`, and an
unparsable-URL navigation against wry 0.57 (the app's predicate refuses it first). **Do not change the instrument**: `sweep.mjs` found a line that aborts the process on bad
input, and changing how it navigates would hide it. Run `MSYS_NO_PATHCONV=1 bun sweep.mjs --route /posts`;
Git Bash rewrites a leading-slash argument into a Windows path, which is how the killer URL was produced.

## The 2026-09-14 hardware session: one suspended measurement

The "Nouvelle discussion" dialog rendered NO result list on A1 for an empty query, `a` and `e` (three runs,
field cleared between each). Not yet a defect: the build pointed at `dev`, where the directory the harness
populates does not exist. One re-run against the LOCAL estate, where a directory with people exists, settles
it; what the session established about reading a device is in
[device-verification](device-verification.md).
