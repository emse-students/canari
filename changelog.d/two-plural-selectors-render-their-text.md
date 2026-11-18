### Fixed - two messages with two plural counts showed their key in a toast

Dropping eleven images on a post that already held one raised a toast reading "post_attachments_partial", and the "deleted everywhere" notice of a sent reel did the same. Their match keys separated the two selectors with a bare space, so no branch matched ([architecture](docs/wiki/frontend/architecture.md#i18n-paraglide)).
