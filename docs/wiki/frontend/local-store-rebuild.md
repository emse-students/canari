# The local store rebuild - how 1.8.1 lost a device's message history, and what makes it impossible

**P1, data loss, shipped in `1.8.1` (2026-11-25), fixed for `1.8.2`.** The v22 -> v23 rebuild of the
SQLite `messages` table (Android, iOS, desktop - every Tauri build) dropped the whole table on at
least one real device on its first open after the update. The rows were not in staging, not in a
retained copy, not anywhere in the file: the user's local history was gone, and every conversation
afterwards held only what arrived since. The web build (IndexedDB) is not exposed - see
[below](#the-indexeddb-twin-is-not-exposed).

Code: `frontend/src/lib/db/sqlite.ts` (`init`, `rekeyMessagesByConversation`),
`frontend/src/lib/db/sqliteMigrations.ts` (`messageRekeySteps`, `messagesRekeySwapStatement`),
`frontend/src/lib/db/sqliteRetained.ts`, `frontend/src/lib/db/storeIncarnation.ts`,
`frontend/src/lib/db.ts` (`getStorage`).

## What the log showed

An exported 1.8.1 Android log, read 2026-11-26 (private; only its shape is kept here):

```
.226 I [SQLite] Migration v22->v23: keying 1858 message row(s) by their conversation
.308 L [LANDING_PREVIEW] local read failed: ... there is already another table or index with this name: messages
.385 E [INIT] Login failed (other): ... there is already another table or index with this name: messages
.455 I [SQLite] Migration v22->v23: keying 0 message row(s) ... (resuming a rebuild a kill interrupted)
.457 / .476 / .478   the same line three more times, within 25 ms
.503 W [FEED-STORE]   ... no such table: messages_rekey
.507 W [LOCAL-COPIES] ... no such table: main.messages
.510 W [PEER-NAMES]   ... no such table: messages_rekey
```

No `now keyed by (conversation, id)` line ever followed.

## The root cause - two defects, proven, one after the other

### 1. The rename was parsed on a pooled connection whose schema cache predated the drop

`tauri-plugin-sql` opens the file with sqlx's default pool, up to ten connections, and every
`execute`/`select` takes whichever is idle (`sqliteBatch.ts` has the measurement). 1.8.1 ran the
rebuild's destructive phase as separate calls - `DROP TABLE messages`, then
`ALTER TABLE messages_rekey RENAME TO messages`. A SQLite connection keeps the schema it last read
in memory and re-checks it only when a statement EXECUTES; but `ALTER TABLE ... RENAME` checks that
its target name is free at PARSE time, against that cache. The rename landed on a connection that had
not run anything since the drop, still saw `messages`, and refused - **with the old table already
dropped and every row only in staging.**

Reproduced exactly, without a phone: two `bun:sqlite` connections on one WAL file, both warm; the
first drops `messages`, the second's rename fails with `there is already another table or index with
this name: messages` - the production string. The same reproduction runs in the test suite against
three round-robin `node:sqlite` connections (`messageKeyByConversation.test.ts`, "a stale connection
cannot refuse the rename") and fails on the 1.8.1 code with that message.

### 2. Every caller of the failed open started its own, at once - and two of them interleaved

`getStorage` shared one open per user, but a caller that JOINED it read a rejected open as "nothing
cached" (`await cached.catch(() => null)`) and started an open of its own. Five callers were waiting
(the landing preview, the login, the feed store, the local copies, the peer names), so five schema
runs started within 25 ms - the four `resuming` lines. Each read the same state (staging present,
`messages` absent and then made again empty by its own `CREATE TABLE IF NOT EXISTS`), each proved
its copy, and each then ran drop-then-rename. One renamed the 1858 rows into `messages`; another,
already past its own proof, dropped that `messages`. The others failed on the tables the first two
had moved (`no such table: messages_rekey`, `no such table: main.messages`) - the three `W` lines.

The proof (`MESSAGES_REKEY_MISSING_COUNT`) was right and was read BEFORE the drop, in another call:
**a proof read before a destructive statement is not a proof at that statement** when anything else
can run between them. The five-concurrent-opens case is pinned by "five opens of the same file at
once" in the same test file, which fails on the 1.8.1 code (`no such table: messages`).

## The fix

**One schema run per file, one open per user, and a destructive step that proves itself at the
moment it runs.** No timer, no retry.

- **`getStorage`: a joiner shares the open's outcome, failure included** (`db.ts`). A failed open is
  the answer every caller that joined it gets; it is forgotten only if it is still the cached one,
  and the NEXT call opens again. Pinned by `storageHandleCache.test.ts` ("callers that joined a failed
  open fail WITH it"): five joiners of a failing open, one open.
- **`SqliteStorage.init` is serialised per database path** (`schemaRuns`, `sqlite.ts`). Whoever asks,
  a second run on the same file waits for the first to settle - `getStorage` is not the only way two
  runs can meet (a `closeCachedStore` that forgets an open still running, then a new `getStorage`).
  A second run asked while one is in flight is said at warn.
- **The swap is ONE `execute` holding ONE `BEGIN IMMEDIATE` transaction**
  (`messagesRekeySwapStatement`). One `execute` is one pooled connection, and sqlx prepares a
  multi-statement string one statement at a time after the previous one ran (its `VirtualStatement`,
  read in the 0.8.6 source; `sqlite3_exec` does the same) - so every statement after the first in the
  transaction is parsed against the file as it is. Inside the transaction, which holds the write lock,
  two guards run before anything moves: both tables exist and no earlier copy is set aside (read from
  `sqlite_master` only, so it parses whatever the file holds), and every row of `messages` is in
  staging. A false guard is a `CHECK` violation under `INSERT OR ROLLBACK`, which ends the transaction
  there: the file is left as it was, the pooled connection carries no open transaction, and the
  caller gets `MessageRekeyRefusedError`. Pinned by the two "the swap refuses" cases, which also write
  through every pooled connection afterwards to prove none is left inside a transaction.

## The essential is never lost: a migration sets a table aside, it never drops it (decided 2026-11-26)

Charter [principle 2](../../principes.md) - *the essential is never lost*. Until this, no destructive
local migration took a copy first; the only protection was the staging table and a proof. The owner
asked for a guarantee that a FUTURE migration defect costs a re-open, not a user's history.

**The rule: a migration that replaces a table holding user data RENAMES the old one to
`retained__<table>` inside its own guarded transaction, and never drops it.** One shared helper,
`sqliteRetained.ts`, is what every destructive migration uses (`retainTableStatements`), and
`settleRetainedTables` settles every copy:

- at **every open, first** - after the connection pragmas, before any table is created, read or
  written - and again by the migration right after its swap;
- it counts the copy and the live table, and proves every retained row is in the live table under the
  live table's PRIMARY KEY (NULL-safe);
- proved: the copy is released by a guarded drop (one `execute`, `BEGIN IMMEDIATE`, the same proof
  re-run under the write lock, `INSERT OR ROLLBACK` on a `CHECK`);
- not proved: said at **error** with both counts, and RESTORED - `INSERT OR IGNORE` of the shared
  columns, which adds every missing row and replaces none - then proved and released;
- a copy that still cannot be proved is KEPT for the next open, and the v23 swap refuses while a copy
  of `messages` is set aside, so no migration ever runs without its copy.

Pinned by "A COPY THAT IS NOT WHOLE IN THE NEW TABLE IS RESTORED FROM AT THE NEXT OPEN" (three rows
deleted from the new table, the copy kept beside it: the next open restores all three, says
`3 of 40 row(s) set aside ... are NOT in it` at error, and releases the copy) and "the swap refuses
while an earlier copy is still set aside".

**Why a table in the same file, and not a sibling file (`VACUUM INTO`), which was the option first
asked for.** `VACUUM INTO` does run through the pooled plugin (one statement), but the webview has no
way to DELETE that file after the proof, nor to swap it back in on a mismatch: both need a native
command, and a swap needs the plugin's pool closed while other callers share it. And it would add a
third copy of the whole FILE on top of the staging copy. The retained table IS the old table, so it
costs nothing beyond what the rebuild already needed, and its restore is one statement. Reversible: a
native snapshot can be added under the same helper the day a migration needs file-level protection.

**Disk cost, measured** (`bun:sqlite`, the real statements, ~450-byte rows): a 1858-row table, about
the size of the device in the log, takes the file from 1.0 MB to 2.0 MB for the length of the open;
50 000 rows from 26 MB to 54 MB. The peak is the old table plus the staging copy - exactly 1.8.1's
peak, since setting the old table aside replaces the drop rather than adding a copy. After the
release the pages go to SQLite's freelist and are reused; the file does not shrink without a `VACUUM`.

**No free space.** The staging copy is written first, and on a full disk SQLite refuses that `INSERT`
(`SQLITE_FULL`) before anything is set aside or renamed: the open fails, the file keeps its v22 shape
and every row, and the next open with space resumes. A migration never runs without its copy, because
the copy IS its first step. What this does NOT give is a usable app on that full disk: the v23 build
writes with the v23 key, so the open is refused rather than run on the old schema.

## The history records did not know the table was gone (decided 2026-11-26)

After the loss the device logged `[HISTORY_RECONCILE] no sweep - away 0 d, inside what the server
keeps; every group already audited`, and its peers - who hold every row - were never asked. The
connection record and the audit record (`historyReconcile.ts`) live in `localStorage`, outside the
store, and survived the table: they answer **"have I already asked"**, never **"is my store whole"**
([durable state answers only the question it was written for](../../../CLAUDE.md)).

- **Already-hit devices: `HISTORY_AUDIT_GENERATION` 1 -> 2** - the documented fleet-wide instrument
  ([history-reconciliation](../protocols/history-reconciliation.md#and-the-fix-does-not-reach-backwards---hence-the-audit)).
  Every device in the fleet compares every group it holds once, on its first connection on `1.8.2`.
- **Every future table loss: the records are bound to the store's INCARNATION.** A value minted when
  the message table is created, stored in the same file (SQLite `store_meta`) or database (IndexedDB
  v16 `storeMeta`, written inside the upgrade transaction) as the rows - so a table that is lost and
  made again cannot keep it (`IStorage.messageStoreIncarnation`, `storeIncarnation.ts`). Both records
  now carry the incarnation they were written under; a different one, or a store that cannot name its
  own, makes the next connection sweep every group, and the audit record of another store is no
  record. SQLite says a table found ABSENT from a file that is not new (and has no rebuild to resume)
  at error - the one place a loss is visible.
- **A record written before this build** (a bare timestamp, an audit with no store) is honoured by no
  named store: its first connection on `1.8.2` sweeps - the same single pass the bump already costs.

**What the heal needs, and what it costs.** One state key or digest per group, once per device,
fleet-wide; for a device that lost its rows, each peer answers with every row it holds in the
asker's window - five years on a phone, ninety days in a browser - and the comparison is not clipped
by the oldest row the asker still holds, nor by the scrollback's "nothing older exists" range
(`historyHeal.lostStore.test.ts`: A holds two new rows, B holds 50 older ones, B's real answer carries
all 50). **It needs a peer that still holds the rows and is online when the device connects** - another
member's device, or another device of the same account. A group whose every holder is offline stays
owed and is asked again at the next connection.

## What can and cannot come back, by kind of conversation

- **DMs and private groups (MLS):** only from a peer device. The server keeps MLS frames, not
  plaintext, and a frame already decrypted cannot be decrypted again (forward secrecy), so the
  server's history replay cannot restore them. Re-delivered by the audit above, bounded by what the
  peers hold and their window (a browser peer answers ninety days).
- **Community salons:** the server keeps every salon ciphertext durably and serves it over REST
  ([channel-encryption](../protocols/channel-encryption.md)), and the Graine seeds that open it are in
  their own table, which the rebuild never touched - salon history is re-read from the server.
- **A `.canari` backup** ([backup](backup.md)) restores every conversation and message it holds,
  merged; it covers only what existed when it was exported.

## The IndexedDB twin is not exposed

The v14 -> v15 re-key (`indexeddb.ts`, `rekeyMessagesByConversation`) runs inside the
`versionchange` transaction, which is exclusive and atomic: a second open of the database waits for
it, a failure anywhere aborts the whole upgrade with the old store untouched, and an `IDBDatabase`
cannot be upgraded twice in parallel. The older `deleteObjectStore('messages')` branches (v < 2, 4, 6)
are deliberate wipes of unreadable rows from years ago, inside the same atomic upgrade.

## Who else is exposed, and what measures it

Every Tauri device that opened `1.8.1` (or a `1.8.2` alpha before this fix) for the first time from a
v22 file ran the rebuild; it lost its rows when the rename landed on a stale pooled connection AND
several callers then reopened at once - which depends on how many connections the pool had warmed,
not on anything the device controls. Nothing on the server can count it: the server never sees local
rows. What the fix leaves as a measurement: the error line `the messages table was ABSENT from a file
that is not new` cannot fire for a 1.8.1 loss (the empty table was made again then), so the
reliable signal is the generation-2 audit itself - a device whose first `1.8.2` connection pulls
many rows (`[HISTORY_REQ] ... diff with ...: N to send` on the PEERS' side, `history_bundle` rows on
the device's) is a device that had lost them. A phone reading of an upgraded v22 store is owed
([backlog](../backlog.d/reading-owed-v23-rebuild-keeps-every-row-on-the-mi9t.md)).
