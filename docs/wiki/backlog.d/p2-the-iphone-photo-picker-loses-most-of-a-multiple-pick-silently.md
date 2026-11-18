## P2 - the iPhone's photo picker loses most of a multiple pick, and says nothing

target: 1.7.1

**Found by:** the toast-over-an-overlay reading, sitting S6 on `1.7.0-alpha.12`, iPhone 12 ([readings](../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)). In the
new-post composer, "Photo/vidéo" opened the system picker (limited library access, short videos); **11 items
picked gave 3 attachments, then 8 more gave 2**. The in-app log holds, once per lost item, at error level:
`[NativeAttachPicker] a picked file could not be read: picked file unreadable: No such file or directory (os
error 2)` (`picked_files.rs` reading the path the picker handed over). The screen showed only the count
("3/10 pièces jointes") - no notice that eight were dropped (principle 2, the essential is never lost).

**What is not known:** which items failed (the log names none) and why the file is already gone - a picker's
temporary copy removed before the sequential reads reach it is the first thing to check. Not a regression:
`nativeAttachPicker.ts` and `picked_files.rs` are unchanged since `v1.6.12`.

**The fix owes:** the cause, a read that cannot lose a picked file, and a notice naming how many were not
taken when one still fails; the reading is the same pick of 11 on the iPhone.
