### Fixed - community names, slugs and role names no longer reach the server logs

`[WORKSPACE] create`, `[INVITE]` and `[WORKSPACE] role set` lines now carry ids (and a character count for the name) instead of the community name, slug or role name; SECURITY.md also states that a DM reaction's push notification still carries the emoji, as a known limitation scheduled for removal.
