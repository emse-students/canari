## P3 - A leave made while the link is down loses its `memberLeft` notice for good (RM-8, 2026-10-25)

target: 1.9.0

When a member leaves while every request fails, `leaveGroupAndBroadcast`'s notice send throws:
`[GROUP] memberLeft notice for <8>… NOT delivered, and not sent later - the members see the roster
change without it: DeliveryUnreachableError`. The exit itself is kept and replayed on reconnect
(`pendingGroupExits.ts`, `[EXIT] ... leave replayed - server removed this user`), but the notice is
not: the local state is already forgotten, so nothing can encrypt it later. The others see the
roster change and the leaver's leaf goes at their next connection (`strayLeaves.ts`), but no
"X left" line ever appears in the conversation. Read on `1.4.1-alpha.3` (dev.9335201) by RM-8. Either
the owed exit carries the notice and its replay sends it before the server step, or the exit
replay produces the notice. RM-8 names the line as expected, in that row only, until then. The
online cousin of this is the GRP-6 entry below (a 403 race), whose fix is ordering.
Re-read 2026-11-11: still real - `pendingGroupExits.ts` carries no notice. Re-read again 2026-12-11.
