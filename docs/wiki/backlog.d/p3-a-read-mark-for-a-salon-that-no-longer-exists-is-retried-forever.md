## Reading owed - a read mark for a salon that no longer exists is dropped (dev)

target: 1.7.0

Seen on most rows of the `1.5.0-alpha.1` replay (2026-10-27): every load on W1 and W2 posts `POST /api/channels/<id>/read-mark` for a deleted salon, gets `404`, and `salonReadMarkQueue.ts` logs `[READ] salon mark ... not delivered - kept, and asked again at the next load`. A `404` there is an ANSWER - the salon is gone - and never a reason to retry: the mark must be dropped on that status (typed by status, never by message) and the drop logged once. Today it is dirt on nearly every row; a fix-after-stable item, not something to narrate.

**FIXED AT THE SOURCE 2026-10-29, owed its reading.** The read-mark route now answers `404 CHANNEL_NOT_FOUND`, `ChannelService.advanceReadMark` turns exactly that into `ReadMarkTargetGoneError`, and the flush drops the mark with one `[READ] salon mark ... dropped - the server answered that it no longer exists` (an unnamed 404, a 403 or a transport failure stay owed); a `channel.deleted` frame forgets the owed mark before any POST ([offline-and-weak-network](../frontend/offline-and-weak-network.md)). **Owed:** a pre-release carrying it on dev, then KICK-COMMIT, SALON-REVOKE-COMMIT and DEVREVOKE-KEYGROUP re-run - the FIRST run still posts the old mark once (one 404 and the drop line), every later run none. Delete this row then. Not done: a `403` (a member no longer allowed into the salon) still keeps its mark owed; not seen in any log.

**Read 2026-11-14 on dev (`1.6.12-alpha.2`, two desktop Chrome profiles, test accounts):** four loads on two profiles logged no `[READ] salon mark ... not delivered`, but no deleted-salon mark was owed either, so this proves nothing yet; still owed: a deleted salon with a mark owed.
