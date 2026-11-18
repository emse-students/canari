### Fixed - four messages with two plural counts showed their key in a toast

Dropping eleven images on a post that already held one raised a toast reading "post_attachments_partial"; the backup-restored and "deleted everywhere" notices did the same. Their match keys used the wrong separator for two selectors, so no branch matched ([architecture](docs/wiki/frontend/architecture.md#i18n-paraglide)).
