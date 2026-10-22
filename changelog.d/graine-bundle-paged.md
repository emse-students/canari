### Changed - a Graine seed answer is bounded in bytes and sent in pages

An answer over 256 KiB, a third of the pending-queue page that bounds every hop it crosses, now goes as several complete bundles under one request id. Each seed is stored on its own, so pages need no reassembly, and a reader that predates pages absorbs each one as an ordinary bundle ([channel-encryption](docs/wiki/protocols/channel-encryption.md#44-joining-and-what-a-share-link-is-worth)).
