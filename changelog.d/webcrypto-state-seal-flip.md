### Changed - the web saves its encrypted MLS state with WebCrypto (framed v2)

A 7.7 MB checkpoint drops from ~198 to ~47 ms in the browser; every supported client already reads the format, and a web rollback below `v1.2.7` is now forbidden ([mls-protocol](docs/wiki/protocols/mls-protocol.md#v2---the-browser-seals-with-webcrypto-every-platform-reads-it-2026-10-12)).
