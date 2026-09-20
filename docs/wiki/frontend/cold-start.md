# The cold start, measured

**THE TARGET IS UNDER ONE SECOND, ALL IN** (user). This page is the MEASUREMENT RECORD behind that
target: every reading, every instrument, and - the part worth the page - **every hypothesis that was
refuted, so no later session re-derives it.** What is still OWED is in
[backlog](../backlog.md), never here; a reading that closes something moves its
conclusion there and its numbers stay here.

**NOTHING ON THIS PAGE MAY BE QUOTED AS THE CURRENT COLD START.** Each section names the build it was
taken on, and the app has moved since most of them. `window.__canariBootBench.get()` in the running
app is the only current reading there is.

---

The first measurement since `v0.18.5`, from the user's own Firefox export of 17:20 on `/posts`,
which contains two consecutive reloads. **`+<ms>` is `performance.now()` - milliseconds since THIS
document's navigation started - so nothing below is inferred.**

| milestone | boot 1 (first load of `0.18.8`) | boot 2 (reload) |
| --- | ---: | ---: |
| the application's first word (`[A] token->refresh`) | 923 | **534** |
| `Initialised in WEB mode (WASM)` | 1089 | **695** |
| `MLS state loaded from IndexedDB` | 1255 | 856 |
| `load_or_create` returns (7 617 611 B of state) | 1482 | 1092 |
| `MLS ready - syncing messages in background` | 1484 | **1093** |
| **`[WS] Connected to Chat Gateway`** | 1690 | **1308** |

**THE 13 s IS DEAD AND MUST NOT BE QUOTED AGAIN.** It predates the Cache Rule and three boot fixes.
The honest number against the user's "under 1 s tout compris" is **1.3 s to a connected socket**,
with the app initialised at 695 ms.

**WHAT DOMINATES IS NOW THE PART NOTHING HAD EVER MEASURED**: 534 ms of 1308 - **41%** - elapses
between the navigation and the first line the application writes. That block contains exactly the
two things already filed beside this entry: the document's own origin round trip (the app-shell
entry, 120-146 ms of it) and the fetch, parse and evaluation of the module graph (the boot-bundle
entry). The export could not separate them; `performance.getEntriesByType('navigation')` can.

## The split, taken 2026-09-16: the ROUND TRIP dominates it, not the bundle

Three consecutive reloads of `https://canari-emse.fr/login` in Chrome on this workstation, each read
straight off the navigation entry, with the first application line's own `+<ms>` prefix as the
closing milestone:

| | A | B | C |
| --- | ---: | ---: | ---: |
| DNS | 33.0 | 0.0 | 0.0 |
| connect (QUIC + TLS) | 19.2 | 10.5 | 10.8 |
| **TTFB (`requestStart` -> `responseStart`)** | **130.0** | **90.6** | **110.2** |
| body (6.7 KB, zstd, h3) | 0.9 | 1.0 | 0.8 |
| HTML parse to `domInteractive` | 63.1 | 28.0 | 29.1 |
| module evaluation after `domInteractive` | 74.1 | 29.7 | 28.6 |
| **the application's first word** | **323** | **162** | **185** |
| first contentful paint | 264 | 152 | 176 |

**THE ORIGIN ROUND TRIP IS 56-60% OF THE BLOCK, AND THE BUNDLE IS 15-23% OF IT.** 113 of the 114
resources report `transferSize: 0` - the edge cache and the disk cache between them mean the ~100
chunks cost almost nothing on a reload, and the 1 248 197 B of the boot-bundle entry buys back at
most the 29-74 ms of evaluation. What is left is a document nobody may cache
(`cf-cache-status: DYNAMIC`, `Cache-Control: no-store`) waiting on `frontend-ssr` in Saint-Etienne
from an edge in Marseille. **So of the two entries filed beside this one, it is the round trip that
is worth the work, and the bundle is worth it only for a FIRST visit.**

**THIS IS THE SHAPE, NOT THE USER'S NUMBER.** It is Chrome, this workstation, `/login`, warm cache;
the 534 ms is Firefox, the user's line, `/posts`, and a session. The proportions are what transfers -
one reload of the user's own browser with these five fields read out would settle the absolute.

## THE PROPORTIONS DID NOT TRANSFER: 56-60% BECOMES 7% (user's Firefox + HAR, 2026-09-17)

**The reload above asked for the absolute and got it, and it refutes the paragraph above it.** A
console export and a HAR of the same boot, taken by the user on their own line at 09:23 on
2026-09-17 against `0.18.9`, `/posts`, 386 requests. Every figure below is the HAR's own clock.

| block | ms | share of the 1342 ms boot |
| --- | ---: | ---: |
| the document (TTFB 94, connection reused, 6 569 B zstd) | **94** | **7%** |
| document's last byte -> the FIRST module request | 122 | 9% |
| 173 modules, 1 333 140 B, all `cf-cache-status: HIT` -> the application's first word | 384 | 29% |
| first word -> `MLS ready` | 580 | 43% |
| `MLS ready` -> `[WS] Connected to Chat Gateway` | 162 | 12% |

**THE ORIGIN ROUND TRIP IS 94 ms OF 1342, NOT 56-60% OF ANYTHING.** The Chrome probe measured 130 ms
of TTFB against a 323 ms block and read that as the dominant term; on the user's line the same round
trip is 94 ms against 1342 and is the SMALLEST of the five. The Chrome reading was not wrong about
Chrome - it was answering a different question, on a different route, with no session and no MLS
state to decrypt. **So the edge Cache Rule beside this entry is worth at most ~80 ms and must not be
quoted as the cold-start fix; what dominates is the 580 ms of session and MLS work after the first
word.**

## WHAT IS LEFT OF THE 43% IS THE ONE SPAN INSIDE IT, AND IT IS 78% ON A PHONE (`bootBenchmark.ts`, 2026-09-17)

**Every number in the table above was read by a human off a HAR and a console export.** That is how
the 580 ms is known to be 43%, and it is also why nothing is known about what is INSIDE it: the five
rows are the five boundaries an export happens to expose, not a decomposition of the work.

**The bench that exists measures the wrong side of the boundary.** `beginStartupCatchupBench()` is
called in `sessionAuth.ts` on the line immediately BEFORE `[INIT] MLS ready`, so it times the sync
that follows and never the init that precedes it. The largest block of the cold start was the only
one with no instrument, and the instrument sat one line past its end.

`frontend/src/lib/mls-client/bootBenchmark.ts` covers it, and it is a SECOND module rather than a
third `kind` on the catch-up bench because all three of its properties are the opposite of that
one's, and a column is only evidence for the question it was written to answer:

| | catch-up bench | boot bench |
| --- | --- | --- |
| what it measures | durations, from `Date.now()` | OFFSETS from `performance.timeOrigin` |
| concurrent steps | one active phase; a new one closes the last | named spans that may overlap |
| what it counts | messages, conversations, acks | nothing - none of it is evidence here |

**The offsets are the point.** A duration-only report has to be read against a HAR by hand, on a
second clock, which is precisely the operation that turned a 94 ms round trip into a "56-60% of cold
start" claim that was really 7%. Anchored at navigation start, a bench line and a HAR line are the
same number. The report also carries the document's own `PerformanceNavigationTiming` - TTFB, body,
`domContentLoaded` - so **it answers the WHOLE table above on its own, and a HAR is no longer owed
for it.**

**The overlap matters and is not a detail.** The gateway handshake is started ~200 ms before it is
awaited and the revocation answer is deliberately held across the local decrypt, both on purpose and
both recorded in this entry. A single-active-phase model would have closed those spans early and
reported the concurrency this entry PAID for as if it were sequence.

**IT RECORDS ON EVERY BOOT AND LOGS ONLY WHEN ASKED.** A flag that needs a reload cannot capture a
cold start: by the time anyone wants the measurement, the boot in question is over. So
`window.__canariBootBench.get()` answers on any build, with no flag and no reload -
`localStorage.setItem('canari_boot_bench', '1')` only adds one summary line per boot on top.

## ITS FIRST RUN REFUTED THE FIRST THING IT WAS BUILT TO TEST (local estate, 2026-09-17)

**The hypothesis was the two PBKDF2 derivations, and it is wrong for this boot and for the user's.**
The PIN login path runs two sequential PBKDF2-SHA256 derivations on the same PIN and the same server
salt - `computePinVerifier` at 100 000 iterations before the PIN check, `deriveDeviceKeyB64` at
310 000 after it - and 410 000 iterations of SHA-256 in front of a boot is exactly the shape that
looks like an answer. **It is not on the path being measured.** `loginImpl` takes the PIN branch only
when neither a keystore nor a device-key vault answered; a returning session takes the `else`, and
the whole PIN block - salt fetch, both derivations, the PIN-check round trip - is skipped.

**And the user's boot is that same branch.** Their export prints `Initialising MLS (vault device key
path)`, which is the log line inside that `else`. So the 410 000 iterations were never in their
580 ms, and the instrument said so on its first run rather than after a change was built on them.
**This is what the section above was written to avoid, and it worked at the first opportunity.**

The first report, read off the scratch browser against the LOCAL estate:

| | offset | duration |
| --- | ---: | ---: |
| document TTFB / `domContentLoaded` / `load` | - | 5.2 / 85.8 / 101.6 |
| `login-start` | 147.4 | - |
| `access-token` | 158.8 | 9.0 |
| `resolve-device-id` | 221.1 | 0.1 |
| `tab-leadership` (leader) | 221.2 | 7.8 |
| `gateway-handshake-started` | 229.1 | - |
| **`mls-init-and-storage`** | 229.5 | **159.1** |
| `revocation-gate` (asked) | 388.6 | 45.7 |
| `auth-token-final` | 434.8 | 0.2 |
| **`MLS ready`** | **435.1** | - |

**NOT ONE OF THESE NUMBERS IS THE USER'S AND NONE MAY BE QUOTED AS A COLD START.** It is a local
estate on a loopback with a small state: the TTFB is 5 ms where theirs is 94, and `mls-init` here
decrypts a fraction of their 7.6 MB. **What transfers is WHICH SPANS EXIST**, and that is the whole
refutation - a branch that does not run costs nothing regardless of whose machine it is on.

**What the run does prove about the instrument**: the offsets, the navigation entry, the overlap and
the `window.__canariBootBench` reader all work on a real browser and a real boot. **The PIN spans are
NOT proven end to end** - this boot never entered that branch, so they stand on the unit tests and
the typecheck alone.

**WHAT IS OWED IS ONE BOOT ON THE USER'S OWN BROWSER**, which is now one console command rather than
a HAR export. Until then no number in this entry's arithmetic has moved.

## THE SECOND RUN IS THE FIRST ANDROID COLD START EVER MEASURED, AND IT MOVED THE SUSPECT (Mi 9T, 2026-09-17)

**The PIN branch is now proven end to end, on the hardware where it is slowest.** The local run
above never entered it, so the PIN spans stood on unit tests alone. This one entered it: a debug APK
built from `99b4ae343` with a clean tree, installed on the Mi 9T over `adb reverse tcp:8081` against
the LOCAL estate, unlocked with a real PIN. Every span the branch declares fired, in order, with no
gap left unattributed.

| | offset | duration |
| --- | ---: | ---: |
| document TTFB / `domContentLoaded` / `load` | - | 0 / 740.4 / 740.8 |
| `login-start` | 3669.5 | - |
| `access-token` | 3696.6 | 0.4 |
| `pin-salt-fetch` | 3705.6 | 77.1 |
| `pin-verifier-pbkdf2` (100 000 it.) | 3782.7 | 114 |
| `resolve-device-id` | 3896.7 | 6.1 |
| `pin-check-request` | 3902.8 | 35.6 |
| `device-key-pbkdf2` (310 000 it.) | 3938.6 | 145 |
| `tab-leadership` (leader) | 4083.9 | 0.2 |
| `gateway-handshake-started` | 4084.2 | - |
| **`mls-init-and-storage`** | 4086.1 | **1621.9** |
| `revocation-gate` (not asked) | 5708 | 0 |
| `auth-token-final` | 5733 | 0.3 |
| **`MLS ready`** | **5736.9** | - |

**THE INTERVAL FROM `load` TO `login-start` IS THE HARNESS TYPING A PIN AND IS NOT APP TIME.** 740.8
to 3669.5 is 2.9 seconds and 51% of the wall clock, and it would be the largest line in this entry if
anyone read it as one. It is not: the app was sitting on the PIN screen waiting for input, and the
rig spent `2152ms` of it switching the keypad to manual and typing. **A human takes longer, not
shorter.** Nothing in that interval is work the app is doing, and no total including it may be quoted
as a cold start - which is exactly why the summary prints BOTH anchors rather than one.

**What is app time is the 2067.4 ms after `login-start`**, and one span is 1621.9 of it:

- **`mls-init-and-storage` is 78% of the measured boot, and it is ONE span with no internal
  structure.** On the loopback desktop run it was 159 ms; here it is ten times that. Whatever the
  target is, this block alone is over it. **It is now the whole question**, and decomposing it -
  WASM instantiation against storage open against the first decrypt - is what the next iteration of
  the instrument owes. Nothing else on this list is worth touching first.
- **The two PBKDF2 derivations cost 259 ms together** - 114 + 145, on a 2019 midrange phone, on the
  branch that actually runs them. That is 12.5% of the measured boot and 4.5% of the wall clock.
  **Real, and not the story.** The hypothesis is now refuted twice: once by a boot that skipped the
  branch, once by a boot that took it on the slowest hardware available.
- **`ttfbMs` is 0 because there is no document request.** Tauri serves the frontend from inside the
  APK, so the origin round trip that dominates the web reading does not exist here. This run
  measures the client and nothing else, which is precisely what makes the 1621.9 unambiguous.

**WHAT THIS RUN DOES NOT SETTLE.** It is not the user's browser and it is not the vault branch: a
returning phone session skips the whole PIN block and enters `mls-init-and-storage` ~400 ms earlier,
and it is against a LOCAL estate whose state is a fraction of production's 7.6 MB. **What transfers
is the ONE ratio** - a block that is 78% of post-login time on real hardware is the target regardless
of whose estate it reads.

## THE 1621.9 MS NOW HAS FIVE CLOCKS IN IT, AND ONE OF THEM IS THERE TO TEST A SUSPICION (2026-09-17)

**The span measured a `Promise.allSettled` of two concurrent things, so its number is the SLOWER of
the two and nothing said which.** That is the same defect as the one this whole entry started from,
one level down: a clock whose reading cannot answer the question its own size raises. The pair keeps
its clock - it is the honest wall time of the block - and each half gains one:

| span | what it brackets | why it is separate |
| --- | --- | --- |
| `mls-init` | `mlsService.init(...)` | half of the `allSettled` |
| `storage-open` | `getStorage(userId)` | the other half, concurrent with it |
| `mls-load-state` | the decrypt inside `_initImpl`, BOTH platforms | the suspect: it opens the snapshot |
| `mls-save-state` | the native snapshot write | **started and never awaited** |
| `mls-list-groups` | `invoke('lister_groupes')` | **awaited**, so it IS on the critical path |

**`mls-load-state` CARRIES THE SAME NAME ON BOTH PLATFORMS DELIBERATELY.** `WebMlsService` and
`TauriMlsService` bracket their own decrypt with it, so an Android report and a browser report answer
the same question with the same word. The user's boot is a browser one and the measured boot is a
phone one; without a shared name the two readings cannot be set beside each other at all.

**THE LAST TWO ROWS EXIST TO TEST ONE SUSPICION, AND IT IS WRITTEN DOWN BEFORE THE RUN RATHER THAN
AFTER IT.** `_initImpl` starts the snapshot write without awaiting it, then awaits `lister_groupes`
immediately after. `saveState`'s own docblock records **2.0 s of a 3.7 s phone measurement** for
writing that snapshot twice. **If the native side serialises invokes, the awaited call queues behind
the unawaited write and the boot pays for a write nobody asked it to wait for** - and no line
anywhere would say so. That is a HYPOTHESIS. It is exactly the shape of the PBKDF2 one, which this
same instrument refuted twice, so it is recorded as a prediction the next run may kill.

`timeBootSpan` is what makes the unawaited half measurable without awaiting it: it wraps the promise
instead of bracketing an `await`, so **a write still running at `MLS ready` is reported OPEN rather
than closed at a moment it never reached**. A span with no end is the honest answer there, and the
summary omits it rather than ranking a duration it does not have.

## AND THE RUN KILLED THAT HYPOTHESIS TOO, WHILE NAMING THE REAL BLOCK EXACTLY (Mi 9T, 2026-09-17)

Second APK, built from the decomposition commit with a clean tree, same phone, same PIN branch,
same local estate. `groups: 5`.

| span | offset | duration | share of the 1988.1 ms after `login-start` |
| --- | ---: | ---: | ---: |
| `mls-init-and-storage` (the pair) | 3450.2 | 1689.2 | 85.0% |
| `mls-init` | 3450.8 | 1688.5 | 84.9% |
| **`mls-load-state`** | 3451.3 | **1644.4** | **82.7%** |
| `mls-list-groups` | 5095.9 | 42.8 | 2.2% |
| `storage-open` | 3450.8 | **2.5** | 0.1% |
| `mls-save-state` (NOT awaited) | 5095.9 | 2712.1 | - it ENDS at 7808, long after `MLS ready` at 5144.4 |

**THE HYPOTHESIS IS REFUTED, AND IT IS THE THIRD THIS INSTRUMENT HAS KILLED.** `mls-list-groups` and
`mls-save-state` start at the SAME instant, 5095.9. The awaited call finished in **42.8 ms while the
unawaited write ran for 2712.1 ms beside it**. The native side does NOT serialise the two, so the
boot never queued behind that write and the suspicion written down above is wrong. It was recorded
BEFORE the run precisely so it could be killed by one rather than quietly become an explanation.

**THE PAIR'S CONCURRENCY BUYS NOTHING, MEASURABLY.** `storage-open` is **2.5 ms** against
`mls-init`'s 1688.5. `Promise.allSettled` was hiding a 675x asymmetry: the pair's number was always
the MLS half, and no arrangement of those two can matter.

**SO THE WHOLE COLD START IS ONE NATIVE CALL.** `mls-load-state` is 97.4% of `mls-init` and 82.7% of
everything after `login-start` - it is `loadStateWithKey` -> `invoke('initialiser_mls')`, the native
decrypt and deserialisation of the snapshot. Everything else inside `_initImpl` together is 44 ms.
**The next question is inside Rust, not inside TypeScript**, and it is the first time this entry has
been able to say that with a number. For FIVE groups.

**ONE THING THE RUN FOUND THAT NOBODY WAS LOOKING FOR**, and it is not on the boot's critical path:
`mls-save-state` costs **2712.1 ms** and starts immediately after init, so the phone spends 2.7 s
writing the snapshot while the catch-up sync runs. `saveState`'s docblock already records 2.0 s of a
3.7 s measurement for writing that file twice. **The question this raises and does NOT answer: when
init has just LOADED a snapshot and changed nothing, what does re-writing it buy?** The stated reason
is that the FCM service must be able to decrypt before any message is processed - which is a reason
for the file to EXIST, not for it to be rewritten with bytes it already holds. Answering that needs
someone to establish whether `initialiser_mls` mutates the state it opens; **nothing here has
established it, and it must not be assumed.**

## A COLD LOAD IS THE PRUNE - 89% OF IT - SO THE NEXT COLD-START QUESTION IS QUEUE ITEM 5 (OXYGEN, 2026-09-17)

The entry below ends by saying the next question is inside Rust. `load_phases` answers WHERE inside:
it benches `from_reader::<PersistedState>` - the one thing a load does over every BYTE - against the
full `load_or_create` on the same bytes, so the pair subtracts.

| pool | full load | prune | CBOR decode | remainder |
| --- | --- | --- | --- | --- |
| 50 | 738.7 us | 500.2 us (**67.7%**) | 44.7 us (6.1%) | 193.8 us |
| 500 | 5.581 ms | 5.008 ms (**89.7%**) | 0.295 ms (5.3%) | 0.278 ms |
| 1000 | 11.374 ms | 10.082 ms (**88.6%**) | 0.562 ms (4.9%) | 0.730 ms |

*(release, 5 groups, 20 samples, logger `Off` - both O(pool) diagnostics left this path in #822/#824.)*

**THE SNAPSHOT DECODE IS 5%, AND THE REMAINDER IS FIXED.** WP-ANR-1's `byte_compat` had already paid
that debt down. What the prune does not account for is ~200-700 us independent of the pool: the
identity deserialise, the storage map move and one `MlsGroup::load` per group. **The group count is
not the problem**, and the snapshot's SIZE is only a problem through what it is made of.

**COMPOSED WITH #824's FINDING** - 88% of the prune is `serde_json::from_slice::<KeyPackageBundle>` -
this says **~78% of a cold load is JSON deserialised to read expiry dates**. A thousand bundles opened
to read a thousand dates.

**SO THIS IS A DEPENDENCY, NOT A NEW LEAD.** Skipping that decode needs an index, the index is a field
in the state blob's header, and the header WRITER cannot move until the reader is the floor
(`minClientVersion`) - queue item 5. The cold-start target and the corruption-classification item are
the same piece of work seen from two ends, and until now only one of them knew it.

**WHAT THIS BENCH STILL DOES NOT MEASURE, stated rather than extrapolated away**: its largest fixture
is a QUARTER of the 7.8 MB `TauriMlsService` records for the handset, and it starts from plaintext
already in memory - neither the file read nor `load_with_key`'s ChaCha pass is in it. The 1644.4 ms
the phone reports for `mls-load-state` includes both, and nothing here has separated them.

##### THE 2712.1 MS: THE MARSHALLING IS GONE, THE RE-SERIALISATION AND THE WRITE ARE NOT (2026-09-17)

The three facts the entry above says must not be assumed, established by reading the two sides:

1. **`initialiser_mls` itself performs no save.** It resolves the at-rest key, calls
   `MlsManager::load_with_key` and stores the manager in `AppState`. The only write on that path is
   the one-shot `migrate_legacy_state_blob` for a pre-v0.11.0 blob.
2. **`load_or_create` DOES mutate what it opens, sometimes**: it runs `prune_expired_key_packages`
   once per native load, and that calls `mark_state_dirty()` when it deletes anything. So a
   post-init write is not always writing bytes the file already holds - but nothing tells the
   TypeScript side which case it is in, and the save is issued unconditionally.
3. **Independently of 2, the snapshot cache is constructed DIRTY on every load**
   (`state_snapshot: RefCell::new(StateSnapshotCache::new_dirty())`), deliberately and with a
   comment: seeding it from the bytes just read would hand a legacy `mls.bin` straight back to the
   first `save_state` and keep the old encoding for ever. So the first save after a load ALWAYS
   re-serialises the whole state, whether or not anything changed. That is a real trade, and the
   2712.1 ms is the first measurement of what it costs.

**AND A THIRD COST WAS FOUND THAT IS NEITHER OF THOSE, AND IS PURE WASTE**: the command returned the
whole encrypted snapshot to JavaScript, which Tauri serialises as a JSON array of one number per
byte - 27.8 MB of JSON for a 7.8 MB blob - for four native call sites that all discarded it. Shipped;
see the CHANGELOG entry. Measured on OXYGEN (desktop, release, a FLOOR for a handset): 95 ms of
`serde_json` encoding plus 220 ms of `JSON.parse` + `Uint8Array.from`, ~315 ms excluding the transport
copy itself.

**WHAT IS STILL OPEN, NOW STATED PRECISELY.** The serialise and the disk write remain. Skipping the
post-init write on a clean restore is gated on facts 2 and 3: the native side KNOWS whether the load
mutated anything (the prune returns a count) and it is the only place that knows, so the discriminator
has to be carried to TypeScript rather than guessed there - the rule this repository keeps about
never learning by failing what a fact could have told you. Fact 3 is the harder half: skipping the
write does not weaken the format migration's determinism (the snapshot stays dirty and the next real
save still rebuilds it), but it does make the moment the migrated bytes reach DISK depend on what the
user does next, which is exactly what that comment was written to prevent. **That is a decision about
migration policy, not an optimisation, and it should be taken as one.**

## THE FIRST MEASUREMENT INSIDE RUST: HALF OF A COLD LOAD IS TWO DIAGNOSTIC LOG LINES (OXYGEN, 2026-09-17)

The entry above ends by saying the next question is inside Rust. `mls-core` had **no load benchmark
at all** - every bench in `mls_perf.rs` measured SAVING - so `benches/mls_perf.rs` gained
`load_or_create_cold` and `load_per_pool_passes`. The pool is the swept dimension rather than the
group count, because the per-load passes walk key packages and because the accumulation is already
known to be unbounded (queue item 2).

**A BENCH THAT INSTALLS NO LOGGER MEASURES A DIFFERENT FUNCTION FROM THE ONE A PHONE RUNS**, and
this is the finding, not a footnote. `log::info!` expands to `if level_enabled { ... }`, so with no
logger installed `log::max_level()` is `Off` and **its arguments are never evaluated**. Two of
`load_or_create`'s arguments are `state_composition_summary()` and `key_package_census_summary()`,
and the second `serde_json`-deserialises every stored bundle, recomputes its `hash_ref` and runs a
substring scan over its key. A device installs `tauri-plugin-log` at info and pays for all of it;
every test and bench in this repository was blind to it. The benches now install a discarding logger
and run each load TWICE, so the gap is a number in the output rather than a claim in a comment.

Criterion, 20 samples, OXYGEN, 5 groups, release:

| key-package pool | load, logger at INFO | load, logger OFF | what the two log lines cost |
| --- | --- | --- | --- |
| 50 | 1.416 ms | 0.829 ms | +0.59 ms (**+71 %**) |
| 500 | 12.17 ms | 6.25 ms | +5.9 ms (**+95 %**) |
| 1000 | 24.52 ms | 12.91 ms | +11.6 ms (**+90 %**) |

And the three per-load passes measured apart from the load, same machine:

| pass | 50 | 500 | 1000 | what it is |
| --- | --- | --- | --- | --- |
| `prune_expired_key_packages` | 0.578 ms | 5.69 ms | 11.49 ms | maintenance, always runs |
| `key_package_census_summary` | 0.587 ms | 5.71 ms | 11.61 ms | a LOG LINE's argument |
| `state_composition_summary` | 0.021 ms | 0.109 ms | 0.209 ms | a LOG LINE's argument |

**SO A COLD LOAD AT A 1000-PACKAGE POOL IS ROUGHLY 1 ms OF DECODE, 11.5 ms OF PRUNING AND 11.6 ms OF
A DIAGNOSTIC NOBODY READ.** All three are O(pool), none of them is needed before the first screen,
and the comment on the census already says in as many words that "the web start-up is not where an
O(n) diagnostic belongs" - while leaving it on the native one.

**WHAT THIS DOES AND DOES NOT SETTLE.** It does not explain 1644 ms: OXYGEN is not a Mi 9T and its
pool is a fixture. It settles the SHAPE - the cost is linear in a pool nothing reclaims, and about
half of it is work the load does not need to do - and it gives the first reproducible number anyone
can re-run. **The next measurement is the same sweep at the pool a real device carries**, which
queue item 2 is already about, and the fix it argues for is moving both O(pool) passes off the
awaited path rather than deleting either: the report is why the leak was found at all. That is a
change in the Tauri command layer, not in `mls-core`, and it is not made here.

## THE PRUNE'S COST IS THE DECODE, NOT THE PROOF - MEASURED, AND IT REFUTED THE FIX THAT ARGUED FOR IT (OXYGEN, 2026-09-17)

`prune_expired_key_packages` is the other O(pool) pass on the awaited cold load, 11.39 ms at a
1000-package pool. It shared a walk with the census that PROVES every row - a `hash_ref` recomputed
per bundle plus a serialisation - while the expiry test needs only the decoded lifetime. The obvious
fix was to prove only the rows about to be deleted, and it shipped: the deleted set is unchanged
(expired AND proven, exactly what the census counts as expired), now asserted by a test rather than
guaranteed by the sharing.

**AND THE NUMBER SAID THE HYPOTHESIS WAS MOSTLY WRONG**, which is the finding worth keeping:

| pool | before | after | change |
| --- | --- | --- | --- |
| 50 | 0.560 ms | 0.495 ms | **-11.5%** |
| 500 | 5.61 ms | 5.05 ms | **-11.2%** |
| 1000 | 11.39 ms | 10.08 ms | **-12.1%** |

The cryptographic proof was **12%** of the pass. The other 88% is
`serde_json::from_slice::<KeyPackageBundle>` on every stored bundle - the DECODE. A thousand bundles
are deserialised to read a thousand dates, and no rearrangement of what happens after the decode can
recover that.

**SO THE REMAINING ~10 ms NEEDS AN INDEX, AND THE INDEX IS BLOCKED.** The storage key is
`label || json(hash_ref) || version` and carries no expiry, so the only way to skip the decode is to
write the pool's expiries - or its earliest `not_after` - where a load can read them without opening
every bundle. That is a field in the state blob, and **the blob-header WRITER cannot move until the
reader is the floor (`minClientVersion`)**, which is item 5 of the queue. Two cheaper-looking routes
are refuted in advance: a partial `serde` shape that decodes only the lifetime still parses the whole
JSON and duplicates knowledge of openmls's wire format in a second place, and an in-memory cache of
the earliest expiry is empty on precisely the path that matters - a COLD load.

**WHAT MUST NOT BE BUILT INSTEAD**: a clock-driven "prune every N hours". Idempotence comes from
durable state, termination from a proof, never from a clock - and a pool that silently stops being
pruned is item 2 of the queue getting worse, which is a P1.

Two things the export settles in passing, both measured rather than argued:

- **The module graph costs almost nothing per chunk and is already entirely at the edge.** 173
  chunks, median 16 ms, slowest 42 ms, 56 in flight at the peak, `cf-cache-status: HIT` on all 173,
  and the last module byte lands at +627 ms - AFTER the application's first word at +600. The
  `Link: rel=modulepreload` header is doing its job: the document body carries ZERO
  `rel="modulepreload"` tags (10 `<link>` tags, none of them preload), so that 10 461-byte header is
  the only early declaration there is, and what it buys is exactly the multiplexed burst above
  rather than a level-by-level discovery. `preloadableAsset`'s docblock says so and this is the
  reading behind it.
- **122 ms elapse between the document's last byte and the first module request**, which nothing had
  ever measured and which no entry here explains. It is 9% of the boot, and whether it is HTML
  parse, zstd decode, the inline bootstrap or Firefox scheduling is NOT known - the export cannot
  separate them and neither may a later reader.

  **BUT ONE READING WOULD SETTLE THE LARGEST OF THOSE CAUSES, AND IT COSTS NOTHING TO TAKE.** The
  header is the only early declaration, so the whole question is WHEN the browser acted on it.
  Compare the first `/_app/immutable/` request against the DOCUMENT'S TWO TIMESTAMPS, not against
  one of them:

  | the first module request tracks | what it means |
  | --- | --- |
  | the document's response **start** (its TTFB) | the `Link:` header was honoured; the 122 ms is parse, decode or scheduling, and is small |
  | the document's response **end** | the header did NOTHING in this engine, and the graph is discovered by EXECUTING the inline bootstrap at the end of `<body>` |

  The measurement already in hand says the gap is counted from the END, which is the second row -
  but it was read as "the header is working" on a different argument (the last module byte lands
  after the app's first word, at +627 against +600), and **that argument is about the header being
  USEFUL, never about when it fired**. The two are not the same claim and only one of them was
  measured. This is the same shape as the 56-60% that inverted: a fact about one mechanism read as
  a fact about the product.

  **IF IT IS THE SECOND ROW, THE FIX IS NOT A TUNING.** `<link rel="modulepreload">` TAGS in the
  head are discovered by the parser in every engine, where an HTTP `Link:` header is honoured only
  by engines that implement header-driven module preloading - MDN's page for `modulepreload` does
  not document the header form at all, checked 2026-09-17. **Do not build it before the reading**:
  emitting the tags means post-processing the response SvelteKit already built, which costs the
  streaming render, and paying that for an engine that never needed it would be the third
  Chrome-shaped decision in this entry.

## WHAT THIS EXPORT COULD NOT MEASURE, AND WHY, SO NOBODY RE-READS IT AS THE ANSWER

**Neither of the two fixes below was in the build.** `v0.18.9` was tagged 2026-09-16T17:18:37Z;
`perf(session): tenir la reponse de revocation pendant le dechiffrement local` (#760) merged at
17:41:58Z and `perf(session): la poignee de main du socket ne fait plus la queue derriere l'etat
MLS` (#764) at 18:35:23Z. `git tag --contains` answers nothing for either. **A build is identified
by what it CONTAINS, never by the fact that it is the latest one** - the tag was cut 23 minutes
before the first of the two landed, and asking for the export against it was the error.

**And the capture had the browser cache disabled**, so every one of the 241 immutable chunks was
refetched: the request headers carry `Pragma: no-cache`. That makes `1342 ms` a NO-CACHE boot, not
comparable to the `1308 ms` warm boot of `0.18.8` above - the only honest comparison between the two
builds is that no boot change separates them, and the two numbers agree. **It is worth one line that
a full refetch of 1.33 MB over 173 requests lands within 34 ms of a warm boot**: the disk cache is
nearly worthless here because the edge already answers every chunk.

**THE EXPORT WAS TAKEN ON 2026-09-18 AND THE PREDICTION IS REFUTED IN BOTH DIRECTIONS** - see
[the measurement](#the-964-ms-prediction-is-answered-1092-ms-and-the-in-app-half-over-delivered-2026-09-18)
below. The in-app half saved MORE than predicted; the end-to-end number did not reach 964 ms,
because the half nobody had been measuring is now 69% of the boot.

## The second block WAS 162 ms and is SHIPPED; what it leaves behind is one corrected claim

The gap between `Initialising MLS (vault device key path)` (856 ms) and `Loading encrypted state
with device key` (1018 ms) was the `/api/mls/devices/.../revoked` round trip awaited in front of a
decrypt that needs no network at all. The promise is now held across that decrypt and read just
after it; the story is in `CHANGELOG.md` and the reasoning sits on the gate itself in
`sessionAuth.ts`.

**ONE CLAIM THIS ENTRY MADE WAS WRONG, AND ENUMERATING THE BRANCHES IS WHAT FOUND IT.** It said a
naive overlap was unsafe because `rotateDeviceIdentity` *publishes*. It does not: `_initImpl`
reaches no publication at all - `generateKeyPackage` is called from `initializeConnection` and
`republishKeyMaterial`, both far past the gate. Its one network step is `deleteDevice`, and
`DELETE /api/mls/devices/:userId/:deviceId` ADDS a `RevokedDevice` row rather than removing one, so
it can only reinforce a revocation. The conclusion the entry reached - hold the promise, gate before
anything acts on the session - was right; the reason given for it was not, and a reason nobody can
re-derive is what this file has already been burnt by once.

**WHAT IS STILL OWED IS THE READING.** 162 ms is a Firefox measurement on the user's own line, and
this workstation cannot reproduce that browser. One reload export of a build carrying the change
says whether the gap is gone.

**THE 2026-09-17 EXPORT IS NOT THAT READING, AND IT IS THE CONTROL INSTEAD.** `v0.18.9` was tagged
23 minutes before #760 merged, so what it measures is the UNCHANGED code: `Initialising MLS (vault
device key path)` at +917, `Loading encrypted state with device key` at +1085 - **168 ms**, against
the 162 recorded here. The block reproduces. That is worth having, and it is not the answer.

**AND THE KEY-PACKAGE LEAK NOW HAS A PRICE IN BYTES.** The same boot prints its own composition:

```
load_or_create: state composition - 7617618B total;
  Tree           26x  2 575 517 B
  MessageSecrets 26x  2 455 685 B
  KeyPackage   1033x  2 453 307 B
[MLS] key package census - 1033 proven (1032 one-time, 1 last-resort);
  0 expired, 0 undecodable; 30 mint instant(s), largest batch 50
```

**32% of everything decrypted on every boot is the unreclaimed one-time pool**, and `0 expired, 0
undecodable` says again that none of the three reclaims applies to it. That is the P1 above; what is
new here is that it is no longer only a count, it is a third of the state this table is timing.

**WHAT IS OWED IS ONE EXPORT PER CHANGE, NOT A CAMPAIGN.** This table is reproducible from any
reload, costs the user one gesture, and every line in it is attributable to a document since #742.

## The LAST block was 215 ms, and the 182 of handshake in it are SHIPPED - what is left is the 33

The same export, second boot, read line by line between `MLS ready` (+1093) and
`[WS] Connected to Chat Gateway` (+1308):

| +ms | line |
| ---: | --- |
| 1093 | `[INIT] MLS ready - syncing messages in background.` |
| 1108 | `[MLS] key package census - 1033 proven` (15 ms, and it is IN FRONT of the badge) |
| 1108 | session/device binding, push service, three API calls fired |
| 1120 | `[TAB] Leadership acquired (Web Locks).` -> `Connecting to Gateway...` |
| 1126 | `[WS] Opening connection -> wss://.../api/ws?device_id=...` |
| **1308** | **connected** |

**THE 182 ms OF HANDSHAKE ARE DONE** (unshipped as of this writing, merged on `main`). It never
needed the state it was queued behind: `connect` sends a device id and a token, both of which
`resolveDeviceId` answers before `init()`. The login now starts the handshake there and awaits it
200 ms lower down; tab leadership moved up with it, because leadership is what decides whether to
open a socket at all. What the concurrency owes is `BaseMlsService`'s inbound gate - every frame
held in arrival order until `markInboundReady`, then replayed sequentially - because the gateway's
delivery accounting cannot tell "handed to a client" from "handled by one", so an early frame with
nowhere to go is a message lost on both ends. Six source guards in `offlineUnlock.test.ts` pin the
order, which is the half a behavioural test cannot see.

**WHAT IS LEFT HERE IS THE 33 ms OF SERIAL WORK, AND IT IS NOT WORTH MACHINERY.** 15 ms of it is the
key-package census, kept deliberately: 1% of the boot does not justify rescheduling, and a claim
nobody re-measured costs more than 15 ms is worth saving.

**THE MEASUREMENT WAS OWED AND IS NOW TAKEN.** The table above is `0.18.8`; the arithmetic
(1308 - 182 - 162 = 964) was a PREDICTION, and the reading that answers it is
[below](#the-964-ms-prediction-is-answered-1092-ms-and-the-in-app-half-over-delivered-2026-09-18).
The two savings did NOT overlap - together they took 261 ms off the in-app phase against the 344 ms
predicted for the whole boot - but 964 ms was still not reached. **No line anywhere may quote a cold
start under a second: the measured figure is 1092 ms.**

**`v0.18.9` IS NOT THAT BUILD AND THE 2026-09-17 EXPORT CONFIRMS IT FROM THE INSIDE**: `[WS] Opening
connection` prints at +1218, still AFTER `MLS ready` at +1180, which is precisely the queueing #764
removes. The handshake itself took 124 ms there against 182 here, and that difference is the
network on the day rather than a change - **read the ORDER, not the duration, to tell whether this
fix is present.**

## HALF OF A COLD LOAD LEFT THE CRITICAL PATH; THE OTHER HALF IS MAINTENANCE AND NEEDS A TRIGGER (2026-09-17)

The criterion benches added the same day say a cold `load_or_create` costs **24.5 ms with a logger
installed and 12.9 ms without**, at a 1000-key-package pool, 5 groups, on OXYGEN. The gap is the
argument of a `log::info!`: `key_package_census_summary()`, which deserialises every stored bundle,
recomputes its `hash_ref` and scans its key. A phone runs `tauri-plugin-log` at info and pays it, on
the awaited path of `initialiser_mls`, in front of the first screen.

**THAT HALF IS SHIPPED OUT OF THE LOAD.** The census is now the `recenser_key_packages` command,
called from the line of `sessionAuth` that already called the web one after `MLS ready` - and the
`!isTauriRuntime()` guard on that line, which looked like it spared native an O(n) diagnostic and in
fact only stopped native doing it at the right moment, is gone with it. The composition line stays
in the load: 0.209 ms at the same pool.

**THE OTHER HALF IS `prune_expired_key_packages`, 11.49 ms at that pool, AND IT IS STILL THERE.** It
is not a diagnostic, it is maintenance: what it deletes must be deleted, and nothing else deletes it.
Moving it therefore needs a TRIGGER, and this repository forbids the obvious one - *idempotence comes
from durable state, termination from a proof, never from a clock*. **The blocking condition, written
so nobody ships a timer instead:** name a durable fact that says "this pool has been pruned since it
last changed", carried in the state blob rather than inferred, and prune when that fact is absent.
Until such a fact exists this pass stays where it is, because a pool that silently stops being pruned
is item 2 of the queue getting worse, and item 2 is a P1.

**NONE OF THIS EXPLAINS THE 1644 ms.** OXYGEN is not a Mi 9T and a fixture pool is not a field pool.
What is established is the SHAPE - the cost is linear in a pool nothing reclaims - plus a
reproducible first number.

## The 964 ms prediction is answered: 1092 ms, and the in-app half OVER-delivered (2026-09-18)

`v0.18.12`, production, the user's own Firefox, route `/chat`, from a console export. **The only
honest comparison is the 2026-09-17 reading above**, taken on the same browser by the same person;
the `0.18.8` table at the top is another machine and another day, and comparing across those is what
produced the prediction this section answers.

| milestone (offset from navigation) | 2026-09-17, `v0.18.9`, cache DISABLED | 2026-09-18, `v0.18.12` |
| --- | ---: | ---: |
| the application's first word (`[A] token->refresh`) | 600 | 696 |
| `MLS ready - syncing messages in background` | 1180 | **1015** |
| **`[WS] Connected to Chat Gateway`** | **1342** | **1092** |
| of which: first word -> `MLS ready` | **580** | **319** |

**THE PREDICTION WAS 964 AND THE ANSWER IS 1092, YET THE FIXES DID MORE THAN THEY PROMISED.** The
two changes were predicted to take 344 ms off the boot. Inside the phase they act on they took
**261 ms off a span of 580**, and `MLS ready` arrives 165 ms earlier end to end. The target is
missed anyway, and the reason is not in either fix.

**69% OF THIS BOOT HAPPENS BEFORE THE APPLICATION SAYS ANYTHING - 696 ms OF 1015.** *(The
attribution of that region to the browser is REFUTED by the boot-bench paste in the last section of
this page: the browser's own share is 249 ms. The time is real; it is spent after the document is
finished and before login begins.)* That is the
whole of the remaining budget and it is the one region no instrument here covers: `bootBenchmark`
starts at `login-start`, and every span in every table above lives in the 319 ms AFTER the first
word. **The two prologues above are not comparable** - 2026-09-17 ran with the cache disabled and
refetched 1.33 MB, so its 600 ms and this 696 ms measure different work, and neither is a regression
against the other. What both agree on is the SHARE: the prologue was 45% of that boot and is 69% of
this one, because only the second half has been optimised.

**WHAT IS INSIDE THE 319 ms IS NO LONGER WORTH ATTACKING**, and the export says so line by line: a
66 ms token refresh, a 57 ms `/api/users/batch` the boot waits on, 68 ms from `Verifying PIN...` to
`MLS state loaded from IndexedDB`, and 71 ms of `load_or_create` deserialising **7 873 982 B** of
MLS state. Nothing there is a mistake; they are the costs of the work. Removing all four would still
leave 696 ms.

**SO THE NEXT READING IS A `PerformanceNavigationTiming`, NOT ANOTHER SPAN.** `bootBenchmark.get()`
already records it unconditionally; what is owed is one paste of
`window.__canariBootBench.get()` from that same browser, which splits the 696 ms into DNS, connect,
TTFB, parse and module evaluation the way the 2026-09-16 table does - and that table's own verdict
was that the ROUND TRIP dominates, not the bundle.

### The log prefix was an instrument, and it was switched off on 2026-09-20 (user, 2026-09-18)

Reading `[17:37:41.866 +428270ms]` seven minutes into a session, the user asked that **this
precision be disabled once the cold-start work is finished**. It was kept past that request for one
stated reason - the 696 ms above was measured WITH it - and the condition it was kept under was
written down at the same time: *the cold start measured under 1 s, or the target formally abandoned*.

**THE CONDITION FIRED.** The 2026-09-20 readings put an ordinary boot at 968 ms, and the offset's
own subject - the distance between the navigation and the app's first word - is now `app-first-line`,
one mark reporting 331-485 ms directly instead of a subtraction the reader performs on every line.
**A second instrument for a question the first one answers is noise on every line the application
ever prints**, which is the objection the user raised in the first place.

`logPrefix()` is one line shorter and `logTruncate.test.ts` now anchors on `[HH:MM:SS.mmm]` with
nothing after it, so the offset cannot come back unnoticed. **The millisecond wall clock stays**: it
is what lines a console export up with a network waterfall, a server log or a second device's
export, it is not cold-start machinery, and removing it would need the user to say so.

## THE OBVIOUS SUSPECT IS REFUTED: 163 MODULE REQUESTS COST 178 ms, NOT TWO SECONDS (OXYGEN, 2026-09-18)

Production, `v0.18.12`, Chrome on OXYGEN, a browser context created for the measurement so its cache
and connection start empty. **This is not the user's Firefox and it does not answer the 696 ms
above** - it answers a different question, asked because the shape of the build makes one hypothesis
look obvious enough to act on without measuring.

**What a cold `/chat` load actually fetches:**

| | |
| --- | ---: |
| `<link rel="modulepreload">` tags in the document | **161** |
| module requests | 163 |
| bytes over the wire, modules only | 602 449 |
| MEDIAN module size | **311 B** |
| modules smaller than 2 KB | **143 of 169** |
| DNS / connect / TTFB for the document | 57 / 29 / 104 ms |
| `domInteractive` | 563 ms |
| `loadEventEnd` | 1211 ms |
| the two largest chunks finish at | 2127 and 2080 ms |
| the first font finishes at | 2476 ms |

A build that ships 143 files smaller than a single packet, and whose two real chunks are the LAST
things to arrive, reads as a chunking defect: raise `experimentalMinChunkSize`, merge the dust, stop
paying 163 round trips. **That is wrong, and one measurement is enough to say so.**

**The measurement.** Fetch the same files with `cache: 'no-store'` on a connection that is already
open and an edge that is already hot, and time them - first one at a time, then all at once:

| | |
| --- | ---: |
| the 126 KB chunk, ALONE, `cf-cache-status: HIT` | **27-35 ms** |
| the same chunk inside the cold page load | 1925 ms |
| all 104 modules of a document, in parallel (985 KB decoded) | **178 ms** |
| the same, re-run | 178 ms |
| 20 modules fetched SERIALLY | 330 ms (16.5 ms each) |

**So the requests are not the cost.** A hundred of them, in parallel, cost less than a fifth of a
second; the flood does not starve the big chunks, because the big chunks are 30 ms of work. What
made the cold load take 2.3 s is the COLD CONNECTION and the edge misses inside it - a congestion
window opening from nothing, not a queue of small files. Merging chunks would have changed the count
and not the time.

**One trap inside the method, worth repeating because it inverted the first answer.** The first
run appended `?probe=<random>` to bypass the browser cache, and measured 508 ms for that same
126 KB chunk - fifteen times the real number. A query string is part of Cloudflare's cache key, so
every one of those was an origin MISS. Bypass the BROWSER's cache with `cache: 'no-store'` and leave
the URL alone, or the number measured is the origin's, not the reader's.

**What this does and does not license.** It licenses leaving the chunking alone, and it removes one
plausible explanation from the 696 ms prologue: whatever that time is, it is not 163 round trips
against a warm cache, which is what a returning reader has. It does NOT measure the user's browser,
their connection, or module EVALUATION - a warm reload here reached `domContentLoadedEventEnd` at
179 ms with all 106 modules served from cache, which is the shape of a prologue with nothing in it,
and theirs is 696. **The reading still owed is the one named above**: one paste of
`window.__canariBootBench.get()` from that same Firefox. **IT ARRIVED - see the last section of
this page.** The prologue is 249 ms and this paragraph's suspicion of the 696 was right for the
wrong reason: the time is real, it is simply not the browser's.

## THE PASTE ARRIVED: THE PROLOGUE IS 249 ms, AND 64% OF THE BOOT IS ONE SPAN NOBODY HAD LOOKED AT (2026-09-18)

> **READ THE 2026-09-20 SECTION BELOW BEFORE QUOTING ANYTHING HERE.** The 64% is a property of
> THIS boot - a post-deploy first load - and not of an ordinary one, where the same span is 8%.

`window.__canariBootBench.get()` from the user's own Firefox, production, navigation start
**19:42:55.895Z**. **READ THE CLOCK BEFORE THE NUMBERS: that is 16 minutes after `v0.18.13` deployed
to production**, so every asset hash had just changed and the HTTP cache held nothing for this
build - the WASM was re-downloaded and re-compiled. This is a POST-DEPLOY FIRST LOAD, the worst
cold start the application has and the rarest one a reader meets.

**IT IS THEREFORE NOT COMPARABLE TO THE 1092 ms ABOVE, AND ANY TABLE PUTTING THEM IN ADJACENT
COLUMNS IS WRONG.** That reading was a warm one on `v0.18.12`. This is the same trap as the
`?probe=` cache-key error further up, wearing different clothes: the measurement is sound, the
comparison is not. What this paste settles is the SHAPE of a boot, and the shape does not depend on
which of the two it is.

| region | span | ms | share | instrumented |
| --- | --- | ---: | ---: | --- |
| the browser's own prologue | navigation -> `load` | **249** | 5% | yes: `ttfb` 91, document body 0 |
| **the gap nothing watches** | `load` -> `login-start` | **1358** | **29%** | **NO - not one mark** |
| login preliminaries | `access-token`, `resolve-device-id`, `tab-leadership` | 1 | 0% | yes |
| **the MLS state load** | `mls-load-state` | **2999** | **64%** | yes, but as ONE span |
| the tail | `revocation-gate`, `auth-token-final` | 1 | 0% | yes |
| | **navigation -> `MLS ready`** | **4677** | | |

**THE 696 ms PROLOGUE IS REFUTED AS A PROLOGUE.** The section above attributed 69% of a boot to the
region before the application's first word, and named it the one region no instrument covered. The
browser's own share of this boot is **249 ms**, of which 91 ms is the origin round trip and **0 ms
is the document body**. Taken with the module-count refutation above (163 requests, 178 ms), both
suspects this file spent 2026-09-18 pursuing are now dead by measurement.

**WHAT REPLACED IT IS NOT WHERE ANYONE WAS LOOKING.** The document is finished at 249 ms and
`login-start` does not fire until 1607. That is **1358 ms between the browser being done and the
application beginning to authenticate, with no mark anywhere inside it** - the same size of hole as
the one just refuted, on the other side of the boundary everybody was watching. `bootBenchmark`
opens at `login-start` by construction, so this region is invisible to it BY DESIGN, and saying so
is not the same as measuring it.

**AND THE SINGLE LARGEST COST IS ONE UNSPLIT SPAN.** `mls-load-state` runs 1677 -> 4676 and carries
`recovered: false`, so this is the NOMINAL path and not a recovery: three seconds of ordinary
start-up. It wraps `loadStateWithKey` ([WebMlsService](../../../frontend/src/lib/services/WebMlsService.ts)),
which does three things of completely different character - instantiate the WASM module, decrypt the
snapshot, rebuild the groups - and reports them as one number. **Nothing here says which of the three
it is, and no fix should be written until something does.** `storage-open` beside it is 2 ms, so
reaching IndexedDB is not a candidate.

**THE NEXT MEASUREMENT IS SMALL AND IT IS THE ONLY ONE WORTH TAKING**: split `loadStateWithKey`,
plus one mark at the first line of application code so the 1358 ms region stops being a subtraction
between two things measured for other reasons. Both are additive, both are cheap, and neither is a
fix.

**AND THE SPLIT IS TWO SPANS, NOT THREE - THE PARAGRAPH ABOVE FIRST SAID THREE AND THAT WAS WRONG**
(corrected 2026-09-20, when the code was read rather than assumed). `loadAndInitWasm` is two lines:
`loadMlsWasmModule()`, then `new WasmMlsClient(...)`. **Decryption and group rebuild happen inside
that one constructor, in Rust**, so no TypeScript boundary separates them and a third span here
would be an invented one. Splitting the constructor is a measurement `mls-core` owes.

**BOTH INSTRUMENTS MERGED 2026-09-20 - AND MERGED IS NOT SHIPPED, WHICH DECIDES WHERE THE READING CAN BE TAKEN.** `#873` landed on `main` AFTER `43a7cea45`, the bump `v0.18.15` was cut from, so **the build production serves does NOT carry these spans**: a paste from it would show the old shape and read as a refutation. The next pre-release puts them on `dev.canari-emse.fr`, the next stable on production, and either is a valid place to read them. `wasm-module` and
`wasm-client-construct` now bracket the two halves of `mls-load-state`, and `app-first-line` is
marked in `hooks.client.ts` - the earliest client seam there is, the same reason the WASM prefetch
sits there. **`wasm-module` IS A WAIT, NOT A DOWNLOAD**: the module promise is memoised and the
prefetch starts it at that seam, so a near-zero value means the prefetch arrived in time and says
nothing about what the binary cost. `installBootBenchDevTools` moved to the same seam, because it
used to run at `login-start` and `window.__canariBootBench` therefore did not exist until the PIN
screen - a boot that never reaches login being precisely the one worth reading. **The reading is
what is owed now, and it is one paste again.**

**ONE READING IS A SHAPE, NOT A BUDGET.** This is a single boot, on one machine, on the first load
of a fresh build. The 64%/29% split is the finding; the 4677 ms is not a figure to quote as "the
cold start" anywhere, and the 1 s target is not measured against it.

## THE SPLIT ANSWERED ON THE DAY IT SHIPPED: AN ORDINARY BOOT IS 968 ms AND `mls-load-state` IS 8% OF IT (2026-09-20)

Three pastes from the same Firefox and the same production, on `v0.18.16`. **That build carries the
two instruments and it was verified in the bytes the browser actually receives**, not inferred from
a merge: `/_app/immutable/entry/app.p6JlViPb.js` contains `W(),A(),k(`app-first-line`)` - the
console shim, the dev-tools install and the mark, in the order `hooks.client.ts` writes them.

| region | refresh | Ctrl-F5 | cache disabled | share (refresh) |
| --- | ---: | ---: | ---: | ---: |
| navigation -> `app-first-line` | **331** | **413** | **485** | 34% |
| `app-first-line` -> `login-start` | **355** | 181 | **358** | 37% |
| `login-start` -> `gateway-handshake-started` | 83 | 141 | 160 | 9% |
| `wasm-module` (the WAIT on the prefetched module) | **0** | **0** | **0** | 0% |
| **`mls-load-state`** (entirely `wasm-client-construct`) | **74** | **71** | **80** | **8%** |
| `revocation-gate` (`asked: true`) | 123 | 191 | 99 | 13% |
| **navigation -> `MLS ready`** | **968** | **998** | **1182** | |

**THE 1 s TARGET IS MET FOR AN ORDINARY BOOT** (user: *"si on peut descendre en dessous de 1s tout
compris ce serait super"*), and **NOT** for one that fetches every asset over the wire, which is
1182 ms. Nothing was done to the load path to get either number - the standing rule was that no
change could be written before this reading, and none was. What changed is what is known.

**THE 64% IS REFUTED AS A PROPERTY OF THE APPLICATION.** `mls-load-state` was 2999 ms on 2026-09-18
and is **74, 71 and 80 ms** across three boots - a nine-millisecond spread on the same machine, the
same `recovered: false` nominal path, two days later. A forty-fold difference nobody fixed is not a
regression; it is a different boot, and the 2026-09-18 one was the rare one.

**AND THE COLD-DOWNLOAD HALF OF THE EXPLANATION IS REFUTED TOO, BY THE THIRD READING.** The leading
account of the 2999 ms was that the WASM binary was in no cache and the prefetch lost its race, the
wait being reported inside `mls-load-state` when that was still one span. **With the browser cache
disabled, `wasm-module` is still 0 ms** - the module promise starts at `app-first-line` and is
awaited 518 ms later, and that head start is enough even with every asset forced back over the
network. So the browser's cache cannot produce the 2999 ms.

**WHAT SURVIVES OF IT IS ONE FORM, AND NO BROWSER CAN MEASURE IT.** Firefox's "Disable cache" empties
the browser's, not Cloudflare's. The 2026-09-18 reading was taken 16 minutes after `v0.18.13`
deployed, when every asset hash had just changed and the EDGE was cold too - an origin fetch from
Paris behind the first request for a new hash. **That is now the only version of the hypothesis left
standing, it has a mechanism and no measurement, and it cannot be taken from a workstation** - it
wants a synthetic first request against a freshly deployed hash. It is not worth building; what it
would establish is that a post-deploy first load is slow, which the 4677 ms already said.

**THE CONCLUSION DOES NOT DEPEND ON WHETHER THE THIRD READING'S CACHE WAS ALREADY OFF.** The user
asked (*"c'etait peut-etre deja desactive ?"*). The prologue answers it - 331 warm, 413 on Ctrl-F5,
485 with the box ticked, and `ttfb` 52 / 32 / 17 - so the three readings straddle the question rather
than settling it. It does not matter: **`wasm-module` is 0 on all three**, including a Ctrl-F5 that
unambiguously bypasses, so no reading in the set is compatible with the prefetch losing its race.

**WHAT IS EXPENSIVE NOW, IN ORDER, AND NONE OF IT IS MLS.**

1. **The prologue, 331-485 ms (34-41%)**: everything before the first line of application code.
   `ttfb` is 17-52 ms and the document body is 0, so this is the bundle - fetching, parsing and
   running it. **It is the largest single cost of a boot, it is the one that grows when the network
   is made to work (331 -> 413 -> 485), and it is the one this file has now chased twice under two
   wrong names.**
2. **`app-first-line` -> `login-start`, 181-358 ms**: still one subtraction with no mark inside it.
   The mark moved the boundary; it did not fill the region.
3. **`revocation-gate`, 99-191 ms**, `asked: true` - a round trip MLS-ready waits on. It is the
   largest *instrumented* span in the boot, and it spans 92 ms across three readings minutes apart
   while `mls-load-state` spans 9 ms. That is the difference between a network call and a
   computation, and it is the reason neither is worth optimising from three samples.

**THREE READINGS ARE NOT A BUDGET.** Same machine, same browser, same account, same account's
snapshot, within minutes. They establish the SHAPE of a boot, that the target is reachable, and that
the MLS cost is small and stable. They establish no distribution, nothing about a phone, and nothing
about a first-ever load on a device with no snapshot to decrypt - which is the boot `recovered:
false` has never been observed against.
