### Added - a WebCrypto-sealed MLS state format, read everywhere and not yet written

The framed `state_blob` v2 (AES-256-GCM through WebCrypto) cuts a 7.7 MB web checkpoint from ~198 to ~47 ms and its cold-start load from ~240 to ~97 ms; this release ships the reader only, read-first ([mls-protocol](docs/wiki/protocols/mls-protocol.md#v2---the-browser-seals-with-webcrypto-every-platform-reads-it-2026-10-12)).
