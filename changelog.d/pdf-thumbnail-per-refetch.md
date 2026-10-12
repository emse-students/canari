### Fixed - a refetch of a salon no longer re-downloads its attachments and restarts a pdf.js worker per PDF

Every attachment row re-ran its download when the thread was refetched with unchanged content, and each PDF thumbnail spawned a new pdf.js worker: 36 worker loads in three minutes on one salon ([web-console-log-audit](docs/wiki/frontend/web-console-log-audit-2026-10-12.md)).
