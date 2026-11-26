## Reading owed - a cloud item picked in the Android app is sent or refused at the pick (2026-11-26)

target: 1.8.2

**Built and tested; read on the Mi 9T on `1.8.2-alpha.8` except for a cloud item** ([chat](../frontend/modules/chat.md#a-picked-file-is-read-at-the-pick-p1-of-181-2026-11-26)). A member's log export, picked in the composer on 1.8.1, was queued with zero bytes: the WebView reads exactly the size the picked document's provider STATES, and the Downloads provider states 0 for some logs. The file chooser now hands the page a native copy read to its end (`PickedFiles.kt`), the save checks the size its provider records, and the composer still refuses a file it cannot read.

**Read on the Mi 9T, `1.8.2-alpha.8` (2026-11-26, [sitting](../device-verification.md#the-readings-of-2026-11-26-182-alpha8-mi-9t-the-v22-store-upgraded-a-picked-file-sent-the-person-filter-tous-in-a-salon)), in a DM:** a gallery photo (sent 30 s after the pick), a video, a PDF, a fresh log export saved to "Telechargements" and an old export listed "0 octet(s)" (`PickedFiles` ERROR `... 269916 bytes, but its provider states 0`) were each copied, read with their real bytes and sent; no `holds no bytes`, no `transient failure`.

**What is still owed** (Mi 9T, the composer's "+" menu, "Phototheque"): a Google Photos item that is NOT on the phone, whose content may be sent (the cloud items the bench phone offers are personal, so none was sent). It is sent like a local photo, or - if the provider gives no byte - refused at the pick with the "Ce fichier n'a pas pu être lu" banner and nothing queued (`[MEDIA] refused a picked ...`).

**What closes it**: that one item passes. A failure names the step: the native copy (`PickedFiles`), the pick's read (`ownPickedFile`), the send's proof, or the outbox's `empty-attachment`.

**iPhone 12, `1.8.2-alpha.8` (2026-11-26, [sitting](../device-verification.md#the-readings-of-2026-11-26-182-alpha8-iphone-12-the-first-open-of-the-store-fix-tous-in-french-a-picked-photo-and-file)): the iOS side is unaffected, PASS.** A photo picked from the native Photos picker and a text export picked from Files (On My iPhone) were each staged in the composer and sent; the bubbles drew the image and the file at its real size (22 KB), "Message envoye". The cloud item above stays owed on the Mi 9T.
