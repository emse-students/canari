## Reading owed - an association document is never swept

target: 1.7.0

**What is built:** an association document is never swept (#1292, in `v1.1.2`)

**The reading that closes it:** on production `/admin/storage` lists `association*` on its own line and no vault download answers 410 for a live document ([media-service](../services/media-service.md#the-sweep-is-an-allowlist-an-associations-document-was-swept-2026-10-01))
