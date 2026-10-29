### Changed - tighten referrer policy and access-log redaction for pages and routes whose URL carries a capability

Join pages, the sign-in callback and the login page now send only their origin as Referer (`strict-origin`, which keeps the real `Origin` header). The container's access log redacts invite tokens, link-preview queries, the callback query, every spelling of a `token` key, and the referer of those pages ([nginx](docs/wiki/infrastructure/nginx.md#urls-that-carry-a-capability-2026-10-28)).
