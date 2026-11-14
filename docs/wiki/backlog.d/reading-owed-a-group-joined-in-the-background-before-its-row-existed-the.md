## Reading owed - a group joined in the background before its row existed: the "already held" Welcome writes and announces the row, the...

target: 1.7.0

**What is built:** a group joined in the background before its row existed: the "already held" Welcome writes and announces the row, the resume merge announces its rows, the gap healer holds a live frame while refused frames wait (PK2, #1999, `v1.3.0`; [mls-recovery-ladder](../protocols/mls-recovery-ladder.md#a-group-joined-in-the-background-before-its-row-existed-pk2-2026-10-14))

**The reading that closes it:** ONE Mi 9T cold start with a group created by another device of the same account while the app was killed: no `LOST frame ... past epoch application frame` and no second `Message for absent conversation` pass for it

**WAITS, 2026-11-14:** the precondition is the NATIVE PUSH JOIN of the group while the app is killed,
and dev has no Firebase sender, so a killed Mi 9T on dev joins nothing in the background. Owed in a
push sitting (the local estate, or dev once it has a Firebase project).
