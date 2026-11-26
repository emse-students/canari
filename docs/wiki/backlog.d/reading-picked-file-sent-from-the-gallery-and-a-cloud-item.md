## Reading owed - a file picked in the Android app is sent, from the gallery and from a cloud item (2026-11-26)

target: 1.8.2

**Built and tested, never run on a device as a send** ([chat](../frontend/modules/chat.md#a-picked-file-is-read-at-the-pick-p1-of-181-2026-11-26)). A member's every in-app pick on 1.8.1 was queued with zero bytes; the composer now reads the bytes at the pick and refuses a file it cannot read. What is owed is the reading below on the Mi 9T, on a pre-release carrying the change.

**What to read** (Mi 9T, a DM and a group, the composer's "+" menu):

1. **Gallery, "Photos et vidéos".** Pick a local photo, wait 30 s with the composer open, Send: the log shows `payload read ... (N file bytes)` with N > 0, the upload ends and the bubble reaches sent. Same for a local video and a PDF through "Fichiers".
2. **A cloud item.** Through the same picker, a Google Photos item that is NOT on the phone: it is sent the same way, or - if the provider gives no byte - it is refused at the pick with the "Ce fichier n'a pas pu être lu" banner and nothing is queued (`[MEDIA] refused a picked ...`).
3. **No retry ladder.** No line `holds no bytes` and no `transient failure` for any of these entries.

**What closes it**: 1 to 3 pass. A failure names the step: the pick's read (`ownPickedFile`), the send's proof, or the outbox's `empty-attachment`.
