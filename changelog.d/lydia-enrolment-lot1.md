### Changed - Lydia enrolment captures the Business key and refuses a second Business

The onboarding proves the private token `business/create` answers with `auth/vendortoken` and stores it encrypted, refuses a re-run while a Business is linked (409), and receives Lydia's unsigned validation webhook as a log line that changes nothing ([payments](docs/wiki/frontend/modules/payments.md#the-key-is-captured-at-businesscreate-enrolment-lot-1)).
