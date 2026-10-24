### Changed - a Graine seed answer is bounded in bytes and sent in pages

An answer over 255 KiB (three to one pending-queue page, the binding hop, MLS framing measured) now goes as several complete bundles under one request id; a history answer missing a page is asked for once more at the next start, and a key-material push over the inline budget is carried by reference at debug instead of warned about. A reader that predates pages absorbs each one as an ordinary bundle ([channel-encryption](docs/wiki/protocols/channel-encryption.md#44-joining-and-what-a-share-link-is-worth)).
