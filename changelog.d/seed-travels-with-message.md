### Fixed - A salon notification is readable on the first banner: the seed travels with the message

Every salon message now carries the frame that holds its session's seed, so a shut phone - and an
iPhone, which no silent push wakes - opens it from the message itself instead of showing
"Nouveau message" and redrawing it later
([channel-encryption §19](docs/wiki/protocols/channel-encryption.md#19-design-the-seed-travels-with-the-message---decided-by-the-user-2026-09-27)).
