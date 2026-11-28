### Added - fast new-mail notifications through an empty push, behind an admin switch that is off

`mail_push = cloudflare` points the account's own Partage alert at a Cloudflare Email Worker that posts only a token, and Canari sends an empty push the phone completes itself; a device the server signs out is told to forget the mailbox ([mail-client-transport](docs/wiki/mail-client-transport.md#as-built---lot-5)).
