### Fixed - A seed that needed a catch-up is kept, so a shut phone behind its community reads salon notifications

The background catch-up decrypted a salon seed sealed one commit ahead of the phone and then dropped
it for carrying no text; both push decrypt paths now share one classifier and one reader
([channel-encryption §18](docs/wiki/protocols/channel-encryption.md#18-the-catch-up-opened-the-seed-and-then-threw-it-away---fixed-2026-09-27)).
