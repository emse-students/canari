# The cross-client campaign - its shape, its scope and its standing rules

What the campaign IS. The live state of every check is
[cross-client-testing](cross-client-testing.md), which carries state and nothing else; how a result
earns the right to be believed is [testing-methodology](testing-methodology.md); how to operate the
instrument is [`tools/cross-client-harness/README.md`](../../tools/cross-client-harness/README.md).

Sibling of [device-verification](device-verification.md), which answers a different question: that
page asks whether a native path works **on hardware at all** (one device, one check); the campaign
asks whether the system stays correct when **several clients, several lifecycles and a damaged
store** meet.

## Where it runs, and what may never leave it

**Target is PRODUCTION** (`https://canari-emse.fr`). Real accounts, real messages, real FCM. There is
no staging that carries push.

**The rig is in this repository**, at `tools/cross-client-harness/` - the scripts that run, not a
copy of them. **Its STATE is deliberately outside**, in a sibling directory `../canari-harness`: the
account file, the two Chrome profiles (which ARE W1 and W2 - their MLS identity, their history, their
login), the verdict record, the APK and the phone baseline. One constant, `STATE_DIR` in `names.mjs`,
bridges the two. Credentials outside the work tree **cannot** be committed, which is a structure; a
`.gitignore` rule would only be a policy, and this repository is public.

The two accounts appear in every document as **owner** (W1, A1) and **peer** (W2). No PIN, login,
display name, device id or group id belongs in a committed file. `idcheck.mjs` reads the staged index
and refuses the commit; run it before every commit that touches the rig.

**Every test message goes in the owner-peer DM, and nowhere else.** A one-off probe once fired a
"dangerous link" warning into a real colleague's thread. Anything needing a CHANNEL uses the
`Campagne de test` community - never MiTV, whose private channels are readable by every association
admin.

## How a check is written

Three rules from the user, and they are one design:

1. **A script covers a FEW checks, never a whole phase.** A file that owns twelve verdicts fails as
   one unit, and a single throw takes the eleven that had nothing to do with it.
2. **A check is INDEPENDENT.** It establishes its own precondition, leaves the clients in a state the
   next check can start from, and asserts nothing that another check had to arrange. Independence is
   what makes them runnable one after another as well as alone - the sequence is then a convenience,
   never a requirement.
3. **The dashboard carries state, never commentary.** [cross-client-testing](cross-client-testing.md)
   holds each check, its state, and the commit it last ran on. Prose belongs on the topical page, a
   story belongs in `CHANGELOG.md`, a rule belongs in [testing-methodology](testing-methodology.md).

## The three transports - read this before reading any phase

| World | What travels | Who can read it |
| --- | --- | --- |
| DM and group | MLS `AppMessage` protobuf, `POST /api/mls/send`. Every MUTATION too - edit, delete, read receipt, pin, reaction removal - as a `SystemMsg{event, data}` sent `silent=true` | members only; the server stores ciphertext |
| Community channel | REST on social-service + a Redis broadcast relayed by the gateway. Server-held `masterSecret` per epoch, NOT MLS | **the server, in cleartext, INCLUDING message bodies** - every epoch key is `HKDF(masterSecret, ...)` and the secret is a plain Postgres column |
| Ephemeral | WebSocket JSON: `ping`, `disconnect`, `welcome_request`, `typing`. Nothing else | online peers, now, or never |

## The ladder

| Token | Meaning |
| --- | --- |
| `W1 W2` | the two browsers, both online, nothing else |
| `+A1` | the phone as a third client |
| `+push` | FCM, so the phone AND a background, doze or killed state |
| `+snapshot` | an MLS or app-data snapshot taken **before** the check, because the check breaks something |
| `+user` | a step no tool here can perform: the owner account's 2FA, the lock-screen pattern, a biometric prompt |

**The order is the numbered ladder and there is no other.** It is ordered by tier, so each rung
assumes what the one below it proved, and it already carries every sequencing constraint there is:
HEAL before MULTI and PIN because it rewinds W1's ratchet in every group, PIN after HEAL because
PIN-3 probes the lockout, CORRUPT last because it destroys state. **A second copy of this order was
kept elsewhere and drifted**, sending a run to FWD straight after READ on 2026-08-15. Two orders in
two places IS the fault; if the order changes, it changes here.

| Tier | What it establishes | Rungs |
| --- | --- | --- |
| A - the floor | nothing higher can be interpreted until these hold, and they are re-proved in the SAME session, never cited from a previous one | 0 SETUP, 1 MSG, 2 TYPE |
| B - a message that already arrived | one delivered message and the states hung off it; each rung adds one mechanism to a path rung 1 proved | 3 READ, 4 MUT, 5 SEARCH, 6 MENTION, 7 FWD |
| C - the container | the conversation itself changes: members, epochs, existence. Everything here can break a path tier B just proved | 8 GRP, 9 COMM, 10 DEL |
| D - several clients, several lifecycles | more than one context of one identity, then the phone, then the phone asleep. A failure here is attributable because A-C fixed what a single online client can get wrong | 11 TAB, 12 MULTI, 13 LIFE, 14 NOTIF, 15 CALL |
| E - deliberate damage | destructive, ordered by how expensive the way back is. Nothing after a rung here is trusted until its teardown restored the invariant | 16 HEAL, 17 PIN, 18 CORRUPT |

### What the ladder is allowed to contain

Two standing instructions from the user govern the scope, and they are why the ladder covers the
feature surface rather than the incident history: *"Vraiment je veux que cross-client-testing soit une
matrice parfaite de tout ce qui est possible de faire avec les messageries/communautes"*, *"Tester les
appels audios et video aussi"*, and *"J'ai dit que je voulais tous les tests possibles, qu'ils soient
plus ou moins absurdes, plus ou moins courant. Un test absurde qui provoque une incoherence peut
servir dans d'autres contextes que celui de ce test absurde"*.

So a hole is visible as an empty cell rather than as the absence of a memory, and the absurd
crossings get rows. That is not a hypothesis: the first question ever asked of the DEL phase - which
existed only because deletion had never been a subject, only a step - found a defect sitting in
production.

## Standing rules for every check

Decided with the user, not to be re-litigated.

- **A defect is fixed and pushed the moment it is found.** Prod is the test server, so the fix is
  verified RUNNING, which is the only thing this campaign is for. Consequence accepted: every deploy
  invalidates the loaded bundle, so `reload.mjs` runs again after each one.
- **Then EVERY check the fix could touch, however remotely, is re-run - err wide.** Verbatim: *"quand
  tu fixes quelque chose, il faut refaire tous les tests qui peuvent etre touches de pres ou de loin
  par ce que tu as fait, vois large"*. A narrow re-run is a guess about a blast radius nobody
  measured, and this campaign has been wrong about exactly that twice.
- **Every fix also pays down the cost of the NEXT check.** Verbatim: *"si tu dois faire un fix,
  profite pour rendre les tests suivants plus rapides et plus faciles"*. An `aria-label`, a
  `role="option"`, a stable `id` is simultaneously what a screen reader announces and what a harness
  selects on, and both outlive a Tailwind class or a portal's screen position.
- **Observation is part of every check, not a debugging step.** A verdict is `PASS` only if the
  assertions hold AND the run is clean, on every client and on the server.
- **Reconciliation runs after every phase, not once at the end.** `recon.mjs` is the only instrument
  that can SEE this codebase's loss class, and a diff taken only at the end cannot say which phase
  opened it.
- **The destructive phases proceed unattended**, PIN and CORRUPT included. The floor under that is
  SETUP-8's archive plus the fact that a full re-enrolment is always possible; it costs the 2FA.
- **The `+user` rows are BATCHED to the end**, not asked for as they arise. **The phone otherwise is
  free** - reboots, radio cycles, forced doze and `install -r` need no warning.
- **NOTHING NAVIGATES THE PHONE ANY MORE, AND THE ONE EXCEPTION SAYS SO.** `goto` refuses A1 unless
  the caller passes `{ relaunch: 'why' }`, because replacing the document re-locks the PIN *and*
  breaks Tauri's in-flight IPC callbacks - which is what MUT-18's `runCallback` dirt was
  (methodology rule 21). `openChannel` is the last holder of that opt-in: there is no click path to
  `/communities` on the phone yet, so a phone verdict inside a CHANNEL check that goes dirty on a PIN
  modal or a `runCallback` exception is the RIG, not the app. Writing that click path removes the
  last A1 reload from the campaign.
- **The phone runs the assets bundled into its APK.** A wire-protocol change reaches the browsers the
  moment CD is green and reaches A1 only through a new build. Either state the fleet is mixed and say
  which branch each A1 row is reading, or rebuild before the device rungs - never report an A1 verdict
  without knowing which of the two it was.

## Pre-flight, and none of it is a check

A run that skips this measures the previous build.

| Gate | Why it is a gate |
| --- | --- |
| Prod version + `minClientVersion` | a client below the floor is bounced, and the run would be measuring the bounce |
| `git fetch` | another contributor pushes to `main`; the local tree is not the deployed truth |
| One app tab per browser | a second tab is a second MLS client on that profile, and every probe resolves a client by position among the tabs. `run.mjs` closes extras before every job; `onetab.mjs` is the manual repair |
| `reload.mjs` on W1 and W2 | a browser left open across a deploy runs yesterday's code and its log is read as if it did not. It detects staleness, repairs it, then RE-ASSERTS the build id |
| `unlock.mjs` | a launch, kill, reboot, radio cycle or `install -r` re-locks the PIN, and a locked client reads as healthy on every screen that is not the gate |
| A1 present and DEBUGGABLE | `run-as` is how every at-rest assertion reads the phone; a release build refuses outright |
| The two profiles hold their identity | `chrome-w1` / `chrome-w2` ARE the devices - fingerprint them (device id, MLS blob size, conversation and message counts) |
| `recon.mjs` W1 vs W2 | the campaign starts from a reconciled fleet or it cannot attribute what it finds |
| `[HISTORY_RECONCILE]` quiet on all three | a client still asking for history is state the run would otherwise blame itself for |

## A commit from another contributor owes a WEB pass and a MOBILE pass

Their tests establish that their code compiles and that their units behave. They cannot establish
that it RUNS against this deployment, which is the only thing this campaign is for. So each of their
commits that lands in a measured surface gets two observations, and they are not the same observation
twice: a panel can render perfectly in a browser and be empty on a phone, because the two halves are
fed by different code.

The device-storage panels are the worked example. The WEB pass is the only one that can see an admin
panel reading four independent backend measurements, one across a service boundary - the exact shape
that fails only on a deployment, silently, when a variable is missing from a compose `environment:`
block. The MOBILE pass is the only one that can see a new Rust command that the web build never calls,
and a Tauri v2 command not granted in `capabilities/` builds, ships, installs and then rejects on a
real device. Three lessons generalise to every future one:

- **Assert on what the PAGE rendered, not on a probe of your own.** A bare `fetch` to the admin
  endpoint got `403` while the page beside it showed all four figures - the access token lives in
  MEMORY, never in a cookie. The 403 was the right answer to the wrong question.
- **Scope a log filter to the app's own pid.** `logcat -b all` carries the whole platform: an unscoped
  search for `forbidden` counted 26 "command rejections" that were the modem printing
  `Received Forbidden PLMNs`.
- **Prove WHICH bundle is running.** An install can succeed over a WebView that then serves a cached
  page, and the comparison must read `performance.getEntriesByType('resource')`, not `script[src]` -
  SvelteKit boots from an inline module, so a selector-based assertion finds nothing and silently
  asserts nothing.

## The negative rows - what does NOT exist

Written down so that no check is invented for them, and so nobody "fixes" one by reflex during a run.
Each was confirmed absent in the code on 2026-08-11, not merely unremembered.

**Messages.** Delete-for-me-only. Editing a channel message. A tombstone for a channel deletion (it is
a hard row delete). Disappearing, expiring or view-once messages of any kind. Chat drafts - the
composer is plain component state, so switching conversation loses it. Global or cross-conversation
search, any server-side index, and any search filter. A mention notification in a DM or group. A
read-receipt privacy toggle. An edit time window or edit history. A per-recipient *delivered* ACK -
`sent` means the server accepted the POST and nothing more. Any "forwarded from" attribution.

**Calls.** Screen share. Camera flip. A busy signal. Any signal back to the caller when the callee
declines. ICE restart or any mid-call reconnection. Android `ConnectionService`/Telecom. Any
participant cap. A call-history screen - the history is the system bubbles in the thread.

**Communities.** Join requests or approval. Bans. Renaming a community. A community description. A
channel description or topic. Channel reordering (only communities reorder). A community-level mute.
An endpoint to revoke an invite link, though the `revoked` column exists. Any MLS involvement in
community membership.

**Two of these are gaps rather than decisions**, and each has a check expected to fail rather than a
shrug: a reply quote keeps showing the snapshotted preview of a parent that has since been deleted,
and jumping to it lands on the tombstone; and `recordCallMissed` is invoked with the LOCAL user's id
on the caller's own device, so the caller sees a missed call from themselves while the callee who
never answered gets no missed record at all (CALL-18). Neither is a Work Package until a check
captures it. A third - a DM pin never reaching a device that was offline - is **fixed** since
2026-08-16, and MUT-15 asserts the recovery instead of the hole.

## Rows that named a mechanism the product does not have

The COMM rows were rewritten on 2026-08-20, and the reason is a class of fault the negative rows above
do not catch: a row can name a mechanism that never existed, or one that has since been deleted, and
still read as a perfectly good check until somebody sits down to automate it. **A row written from
what the product was believed to do is a claim about the product, and it expires.**

Four rows were rewritten, each for the same reason:

| Row | What it named | What is there |
| --- | --- | --- |
| COMM-6 | a CUSTOM role, created through the panel | `POST /api/channels/roles` is served and **no client calls it**. The panel renders the three roles a community is created with and a grid over them, and offers no way to make a fourth. The row now asserts the grid, the three defaults and a toggle that reaches the column; the unreachable endpoint is RECORDED by the runner, not asserted - a check cannot demand a feature, and only its owner can say whether an endpoint no client reaches is dead weight or an unbuilt one. |
| COMM-9 | a per-member key the server "revokes" | there is no such object. What the server does is drop the member's **routing rows** on the salon's distribution group, so the next Graine session never reaches them; the row asks for that, plus the previous session still opening. |
| COMM-13 | an admin being "granted" a private salon | joining one is an action the admin performs, not a grant. The row asks what a join changes - `distribution-group` 403 before and 200 after, the member list, the transcript unchanged, the row ceasing to offer the join. |
| COMM-22 | a function that had been deleted | it timed a code path that no longer exists. The row now times the FIRST RENDER of a salon carrying many Graine sessions, and the repair when one seed is missing - both observable from outside. |

Three rows were ADDED at the same time, for the per-salon distribution groups that shipped 2026-08-20
(COMM-23, COMM-24, COMM-25), which is what takes the phase to twenty-five.

**The rule this leaves.** A row is written against a mechanism that can be pointed at in the code or
in a log line, and a row that cannot be is rewritten before it is run - never automated as written and
never "checked by hand". The cost of not doing this is not a failed run: it is a PASS on a check that
was measuring nothing, which is the one outcome the campaign has no defence against.

## The at-rest artefacts

Enumerated for real at SETUP-7, not guessed - a corruption test written against a guessed key name
tests nothing and passes silently. **The web artefacts are keyed by the USER id**, so a test
hardcoding one client's key silently no-ops on the other. The device id is what the SERVER knows the
client by; it names no local artefact.

**Any check that reaches for a web artefact must enumerate `indexedDB.databases()` and match, never
construct a name.** A probe that built the names from the documented pattern reported "DB ABSENT" for
both databases - and worse than the wrong answer is what producing it cost: `indexedDB.open(name)`
CREATES when the name is absent, so the guess did not fail, it manufactured two empty databases
inside each profile under test and then declared the real ones missing.

| Client | Artefact | Path / key |
| --- | --- | --- |
| Web | MLS state | IndexedDB `CanariDBMls_<userId>` v1, store `state` |
| Web | message store | IndexedDB `CanariDB_<userId>` v6: `conversations`, `messages`, `outbox` |
| Web | device key vault | `sessionStorage.canari_device_key_vault` + `canari_device_key_vault_key` |
| Web | vault persistence flag | `localStorage.canari_device_key_persist` |
| Web | device id, last active, saved user | `localStorage.mls_device_id_<userId>`, `canari_last_active:<userId>`, `canari_saved_user` |
| Web | WS auth | cookie `canari_ws_token` - the only cookie readable from JS |
| Android | MLS state | `mls.bin`, at the app data **ROOT**, not under `files/`. ChaCha20-Poly1305, `[nonce 12 \|\| ct]`, **no version field** |
| Android | message store | `canari_<dev>.db` + `-wal` + `-shm`. **WAL mode, and the WAL is where the data is** - corrupting the `.db` alone tests nothing |
| Android | pending MLS, channel keys, push context | `mls_pending.db`, `channel_keys.json`, `push_context.json` |
| Android | device key | `shared_prefs/keystore_aliases.xml`, `<alias>_ct` / `_iv` |
| Android | push secret, native flags, app log | `pending_push_secret.txt`, `fcm_token.txt`, `native_flags.json`, `logs/Canari.log` |
| Android | WorkManager | `no_backup/androidx.work.workdb*` |

`run-as` reaches all of it **only because the installed build is debuggable**; a release build refuses
outright. Worth recording what is NOT there: **no access token in any web storage**, on either client
- the "access tokens in memory ONLY" rule holding in production.

## The campaign owns its own debris, and clearing it is a check in itself

A campaign that creates groups, devices and backlogs on the PRODUCTION database leaves state behind
that later runs then measure - and cannot tell from real traffic. Clearing it is the last step of the
ladder, after CORRUPT's rollback.

**Delete test groups through the UI, never by SQL.** `DELETE /api/mls/groups/:groupId` emits nothing
to clients: the notice is an E2EE MLS `groupDeleted` system message the CLIENT sends *before* calling
the server, precisely because the server call hard-deletes `dm_group_members` and strips the routing a
later message would need ([groupActions.ts](../../frontend/src/lib/utils/chat/groupActions.ts)). An
`UPDATE` straight into Postgres leaves the peer holding a live MLS group for a conversation that no
longer exists - manufacturing the exact orphan state this campaign hunts.

**Revoke a dead client generation, do not delete its rows** - see
[chat-delivery](services/chat-delivery.md) for why. And two rules for any destructive cleanup script,
both learnt by nearly getting them wrong:

- **Name the target, never infer it.** The device dialog labels its rows "Appareil 1/2/3" and shows no
  id, so pressing on an ordinal is a guess between this browser, the phone and the debris - and a
  wrong guess destroys a live device's access. The id is in a `title` attribute; the script matches on
  it and **fails** unless it finds exactly one match.
- **Assert the post-condition, not the click.** The delete is asynchronous (MLS broadcast, then the
  server call), so a loop counting clicks reports success for a no-op. Poll until the entry actually
  leaves the sidebar.

A cleanup script must also only ever match the harness's own name prefixes: a real user's group sits
in the same sidebar.
