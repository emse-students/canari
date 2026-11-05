## P2 - the boot drain handles frames before the restore has seeded their rows: a race that heals, at every cold start

**Seen** on the Mi 9T reading of `1.6.5-alpha.1` (2026-11-05) and already on 2026-11-04 (so **not
new in 1.6.5**: `unackedFrames.ts` and the `absent-conversation` refusal in `setupMessageHandler.ts`
`handleKnownGroup` are unchanged since `v1.6.3`; #3030, #3035 and #3026 do not touch this order):

```
12:10:46.213 [MLS] Message for absent conversation 285dca2f… - retry after restore      (x6, 3 DMs)
12:10:46.356 W [PENDING] 6 frame(s) left unacknowledged ... absent-conversation: 6 [285dca2f, 5b7609b5, 6f07a5ba]
12:10:46.415 [RESTORE] 22 conversation row(s) seeded - history follows
12:10:46.415 [QUEUE] conversation rows seeded: re-fetching for 3 group(s) left behind as absent-conversation
```

**Mechanism.** At a cold start `loginImpl` opens the gateway and only then awaits
`loadAndRestoreConversations` (`sessionAuth.ts`, the `load_conversations` phase). The socket's open
starts the boot pull, so the drain runs CONCURRENTLY with the restore's phase 1 - which writes every
row it will ever write from the local store (`conversations.ts`, `[RESTORE] N conversation row(s)
seeded`). A frame of a group held in MLS whose row is not seeded yet is refused `absent-conversation`
and left in the server queue; `notifyConversationRowsSeeded` re-fetches it ~60 ms later and it is
applied. Nothing is lost - and that is exactly why it is a defect, not a heal
(`CLAUDE.md`: *a race that heals cleanly is still a defect*; durable rule *"nothing is processed
before the thing that can process it exists"*). The `[PENDING]` WARN is the honest end of it, and
`unackedFrames.ts` itself says an `absent-conversation` frame "is a window somebody re-opened". This
is that window, at boot, for groups the device already had: each costs a refusal, a re-pull and a
WARN.

**The fix is an ORDER, not a retry**: the drain must not hand a conversation frame to the handler
before the restore's phase 1 has seeded the rows - an EVENT (the seeding), never a clock. Candidate
shapes, to be weighed against the deadlock risk (does phase 1 await anything the drain holds - the
MLS lock, `ensureMls`?):

1. the boot pull starts on `notifyConversationRowsSeeded` rather than on the socket's open, at cold
   start only (a reconnect has its rows);
2. or the handler, on a missing row while the boot restore has not seeded yet, awaits that one
   event instead of refusing - but only if phase 1 provably never waits on the queue.

**Done when** a cold start on the Mi 9T with queued DM frames shows no `absent-conversation` refusal
and no `[PENDING]` line, and `restoreKeepsSalonRows.test.ts` / the PK2 rows (#1999) still hold.
