## P3 - the rig's console classifier calls a seat's ordinary start lines "unexplained", so a KILL row cannot read clean (2026-11-17)

target: 1.7.2

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

**Seen on dev `1.7.0-alpha.9`, KILL-3 of 2026-11-17**
([device-verification](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha9-both-phones-and-the-rig)):
twelve runs, every assertion held (no frame accused, every message once), and the row still recorded
`PASS-DIRTY`. The W1 and W2 windows' `unexplained` lists (20 and 30 lines) are what any seat prints
when it opens: `[GRAINE] the history of community ... is not asked: ...`, `[LEDGER] opened the ledgers
...`, `[NICKNAME] ... restated for the notifications`, `[CHAT_VIEW] ... entry settled`, `[chat.entry]
widening window ...`, the `[PENDING] ... invitation fulfilled, vouching` lines of a fresh group, and
the `[REGISTER] ... owes its register` / `register received (join push)` pair that `1.7.0-alpha.9`
added (#3777). A KILL row reloads its seat on every run, so it meets all of them every time.

**Why it matters.** A row that is dirty on every run teaches its reader to skip the dirt, which is the
line that hides the next defect (the noise rule). The classification is the rig's
(`srvlog.mjs` and the console rules beside it, `srvclassify-selftest.mjs` pinning them): each of these
lines is expected and necessary, so each gets a rule naming why, and the selftest a case.

The same run's SERVER window was also dirty with lines of other seats (gateway `No pong ... closing dead
connection`, push lines), because the phone sitting drove W4 and W5 while the row ran; that half is
the sitting's, not the classifier's.
