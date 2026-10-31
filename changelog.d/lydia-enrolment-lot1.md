### Changed - Lydia enrolment captures the Business key and refuses a second Business

The onboarding proves the private token `business/create` answers with `auth/vendortoken` and stores it encrypted, refuses a re-run while a Business is linked (409), and receives Lydia's unsigned validation webhook as a log line that changes nothing. Any failure after the Business is created is one typed 502 telling the manager not to retry, logged `[LYDIA-ORPHAN]` with the vendor token an admin hands Lydia's support; a create with no answer re-reads the account and says to check before retrying ([payments](docs/wiki/frontend/modules/payments.md#the-key-is-captured-at-businesscreate-enrolment-lot-1)).

The paste-the-key field is removed; its route answers old store builds a typed 410 and writes nothing ([legacy-compatibility](docs/wiki/legacy-compatibility.md)).
