## P1 - The ledgers that must follow the MLS state live in `localStorage`, which an unclean exit loses for seconds after each write (KILL-2, 2026-10-25; design owed)

target: 1.8.0

Chrome commits `localStorage` to the profile LAZILY: on a fresh profile a write made 2 s or 4.5 s
before a hard kill of the browser was lost, one made 7 s before survived, and an IndexedDB write
made beside it survived every time (probe of 2026-10-25; Chromium also rate-limits those commits,
so a busy page can wait longer). The MLS state is written to IndexedDB (web) or `mls.bin`
(native), durable when its checkpoint completes. Every ledger whose job is to describe that state
and is kept in `localStorage` can therefore be BEHIND it after a browser killed, a crash, or an
app swiped away (the Android WebView keeps the same store in the app's process). Three do:

- **The leaf-refresh ledger** - closed by naming the leaf in each entry
  ([mls-protocol](../protocols/mls-protocol.md#the-periodic-leaf-refresh)); the cost had been one
  extra refresh commit per such exit.
- **The seen-ciphertext ledger** (`history_seen_cipher:<user>:<group>`, `history.ts`). Its marks
  are written after the checkpoint that holds their ratchet advance (`commitPendingHistoryMarks`),
  and its docblock calls the remaining window "microseconds"; it is the store's commit delay. KILL-2
  measured the result: a read receipt consumed seconds before the kill was re-walked by the next
  history catch-up, MLS answered `SecretReuseError` at the device's own epoch, and the client logged
  `frame never read here and unreadable for good (secret-reuse)`, a `[FORK] not a fork` line and a
  reconcile ask - for a frame it had read. No consumption path skipped the mark (the held-back frame
  was drained through the ordinary pipeline after the merge); the mark was made and not kept.
- **The send-ratchet ledger** (`sendRatchetLedger.ts`), whose header chooses `localStorage` as the
  store "that survives the teardown". It survives a TAB teardown; it does not survive the browser's
  or the app's process dying within the commit delay of a send whose checkpoint (not awaited on the
  send path) had not landed either. The device then reloads a ratchet behind a frame that left and
  re-issues its generation: the peers refuse the next frame (`SecretReuseError`) - a real message
  lost, the defect that ledger exists to prevent. Not yet measured; the window is the same.

The design question is where these marks live so that they reach disk WITH the state they
describe, on both platforms - an IndexedDB store written in the checkpoint's own transaction on
web, and the MLS state or a file the native checkpoint writes beside `mls.bin` - and what each
reader does at startup. Measure first: a KILL-2 run with per-run console capture on each window,
and a kill after a send. KILL-3 is that kill on the WEB side since 2026-10-26: W1's browser, after a send
and after a receive. The NATIVE half (`mls.bin`) has no row, because no rig tool holds the Tauri
commit POST. Re-read 2026-11-11: still real - the seen-ciphertext marks (`history.ts`) and the
send-ratchet ledger (`mls-client/sendRatchetLedger.ts`) still live in `localStorage`; the design is
owed. Re-read again 2026-12-11.
