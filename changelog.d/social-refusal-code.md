### Fixed - a social-service refusal reached the app without its code

`socialRequest` dropped the server's `code`, so a screen mapping one (`PROPOSAL_SENDER_GONE`) never saw it; it now reads the code with `refusalFromResponse`, like every other client ([social-service](docs/wiki/services/social-service.md#a-follow-of-a-person-is-a-request-first-wp-f1-migration-114-decided-2026-10-25)).
