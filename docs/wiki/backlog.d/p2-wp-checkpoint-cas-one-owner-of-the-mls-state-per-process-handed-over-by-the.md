## P2 - WP-CHECKPOINT-CAS: one owner of the MLS state per process, handed over by the platform (2026-10-27, design reviewed four times, nothing built)

target: 1.9.0

**What it changes.** On a phone, the visible app and the background engines share one process and one
state file. Today a heartbeat deadline decides who may write that file, and on Android the page's
visibility never changes, so the heartbeat keeps running while the app is hidden. This WP replaces
the deadline with an explicit owner register held under the existing state-file write lock:
`Vacant`, `Foreground` (the live manager owns the file and background work stays queued) or `Parked`
(the app is hidden, the live manager is frozen and checkpointed, and background engines work from the
file by compare-and-swap). Ownership follows a host-visibility flag that the platform's lifecycle
callbacks write and that is re-read under the lock at every transition. A live call counts as
visible. The unpark runs inside the WebView's mutex grant, so nothing waits for it.

**Four pull requests, no runtime switch, each better than main alone:**

1. **The outbox.** One Rust module owns both outbox files behind one OS file lock and writes them
   atomically. Every sender claims its entries before sealing them and settles them incrementally.
   Closes a queued reply erased by a concurrent rewrite, a message sent twice by the background and
   the app, and a lost update of the sent log.
2. **The teardown and the job fence.** Manager, device key and register are reset in one hold, and
   every background job is fenced by the generation it started under. Closes state resurrected by a
   background job after sign-out. **The one-hold teardown of the manager and the key is BUILT
   (2026-10-27, `end_native_session`, [mls-protocol](../protocols/mls-protocol.md#the-native-manager-does-not-outlive-its-account-2026-10-27));
   the generation is what is left.** The native slot has no session generation today: a command issued
   by a destroyed client A that lands after B's `initialiser_mls` acts on B's manager, since the slot
   says only `Some` or `None`, never whose. Only the TypeScript side fences it (the holder retires A's
   client before B's login opens anything). The fence: a generation the install stamps and every
   command carries, refused typed on a mismatch.
3. **The register.** The register itself; a native park that writes nothing when nothing changed;
   an unpark that holds no command lock across a decrypt; one native visibility event for the page;
   on Android, the socket paused while hidden; frames in flight tracked in both directions; a pending
   external join skipped by every background writer. Closes background delivery starved while the app
   is hidden, the resume that overwrote a background advance, the blind checkpoint, and a frame
   stranded by a commit on either side. Jobs with a server effect keep today's refusal.
4. **The stages.** A background key-group join is staged inside the state file, hidden from every
   group listing until it is settled, and settled from the server's answer by whoever owns the file
   next. Closes the joined-but-not-held loss, apart from a bounded late-landing window that is
   reported. A host test settled the precondition on 2026-10-27: a pending external join survives a
   save and reload, and dropping the group leaves the key store byte-identical. That test, and a
   corrected docblock for the external join, land in their own small pull request ahead of PR4.

The design (lock order, interleavings, tests and device rows) is written into the wiki page of the code
each pull request changes, as it lands. Until then this row is its summary. **Ahead of all four:** a
small pull request lands the host test of the precondition and corrects the external join's
docblock, which still calls the join's commit staged.

**Decided.**

- **REJECTED 2026-10-23:** a per-group reconcile of the file into the live manager (a heal).
- **REJECTED 2026-10-27:** background engines borrowing the live manager; a park driven by the
  WebView; a park triggered by the renderer's death (the process dies with it); a transition waiting
  for background jobs; an outbox guarded by two lock families; a park request matched on the session;
  exporting call keys from a parked manager; a server-side fence for the late landing.
- **Lock order:** WebView MLS mutex -> background state lock -> checkpoint lock -> manager mutex ->
  state-file write lock. The outbox lock (one file descriptor per acquisition), the key-group ledger
  lock and the in-flight set lock are LEAVES: they may be taken under anything, and nothing is taken
  under them.
- **On Android the socket follows the host while no call is live**, so a hidden phone is reached by
  push.

**Owed after:** the tests in the design (red on main where today's seams allow); Mi 9T rows D1-D10;
iOS rows after a manual iOS compile; a one-time reader for the old join files, with a removal date.

**Brief for an agent (batch 15, 2026-11-12; MLS and native - opus, adversarial review before each merge, every PR born `--draft`).** Build in the order above, one pull request each, each mergeable alone. **PR0 first:** the host test that a pending external join survives a save and a reload and that dropping the group leaves the key store byte-identical (`mls-core` tests), and the corrected docblock of the external join, which still calls its commit staged. **PR1, the outbox:** one Rust module in the app crate owning both outbox files behind ONE OS file lock (`fs2`/`flock`, one descriptor per acquisition), atomic writes (temp file + rename), a claim before sealing and an incremental settle; the Android drain (`CanariFirebaseMessagingService.kt` `drainOutboxBackground`) and the app's flush call it instead of rewriting the files; tests: two writers interleaved never lose an entry, a claimed entry is sent once. **PR2, the job fence:** a session generation stamped at install (`initialiser_mls`) in the native slot, carried by every command, a typed refusal on mismatch (`state.rs` `live_manager`), with a test that a command of client A after B's install is refused. **PR3, the register:** `Vacant | Foreground | Parked` under the state-file write lock, written from the platform lifecycle callbacks (Android `onStart`/`onStop`, iOS scene phase) and re-read under the lock at every transition, in the lock order written above; a live call counts as visible. **PR4, the stages:** the background key-group join staged in the state file, hidden from listings until settled. Each PR writes its part of the design into the wiki page of the code it changes, and lists the Mi 9T rows (D1-D10) it owes. Do not build a reconcile of the file into the live manager, nor any of the variants REJECTED above.
