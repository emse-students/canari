### Security - a sign-in handoff is minted only for someone MiConnect would let into the site

Before signing, core-service reads, with a new read-only MiConnect account, whether the person is
the account's own MiConnect user and active, and whether the site's application and its login and
authorization flows carry no access policy, and refuses otherwise; every site's
handoff flag stays off
([sessions](docs/wiki/sessions.md#the-sign-in-handoff-to-the-miconnect-sites-2026-11-08)).
