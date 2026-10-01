### Fixed - the media sweep deleted an association's vault document; it now deletes chat media and nothing else

Vault uploads named no retention class and the idle sweep took everything no exemption named, so one `les-rootz` document answered 410. The sweep is now an allowlist of `ephemeral`, vault documents are `association` (kept, and surviving the uploader's account), and a gone file says "upload it again" instead of "download failed" ([media-service](docs/wiki/services/media-service.md#the-sweep-is-an-allowlist-an-associations-document-was-swept-2026-10-01)).
