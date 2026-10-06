### Fixed - the resume reload no longer puts the receive ratchet back

A frame read after the last checkpoint was invisible to the send-only guard, so a resume re-installed an older `mls.bin` and the spent generation decrypted twice. The live manager now says whether it is ahead of the file, under the lock the swap holds ([mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md)).
