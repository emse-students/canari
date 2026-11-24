## P2 - an upload that finishes after the account erasure keeps the erased owner on a live file

target: 1.8.0

**Found** in the review of #4055 (pre-existing). media-service's erasure route
(`DELETE /media/internal/users/:userId`) first ends the account's open upload sessions
(`UploadSessionService.cancelAllOwnedBy`), then deletes every object the account owns
(`MediaService.removeAllOwnedBy`), and answers `failed: 0`, which tells core-service's erasure queue
the media half is done. Nothing stops an upload that is REGISTERED after that answer: a session
created afterwards by a device still holding a valid access token (or a single-request upload) ends
in `registerUpload` with the erased account as `ownerId`. That live entry carries the erased id, and
nothing erases it again: the queue never calls the route a second time.

**Why it is not fixed in #4055.** The fix is not a line: media-service holds no durable record that
an account was erased. It needs one - an erased-owner set persisted with the media index, kept at
least as long as an access token can outlive the account - read by every path that registers an
object (the resumable `complete`, the single upload, the live segments), which refuses the
registration (and releases the staged bytes) for an erased owner.

**The test that closes it.** In `apps/media-service/src/media/upload-session.service.spec.ts`: open a
session for ALICE and send every part; call the erasure (`cancelAllOwnedBy` then `removeAllOwnedBy`)
for ALICE; open a SECOND session for ALICE with the same token's identity, send its parts and call
`complete` - it is refused (403 or 410), no object is stored, and no entry of `meta.items` names
ALICE. The same assertion for the single-request upload path in `media.service` specs.
