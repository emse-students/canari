### Added - the mail client's transport (lot 1), switched off

A TLS client in WASM for the school mailbox, a blind relay on chat-gateway for eligible accounts
(off unless `MAIL_RELAY_ENABLED`), a native socket for the apps, and HTTP/1.1 + Zimbra SOAP on top.
Eligibility is MiConnect's new `school_mail` claim (CAS accounts, Canari only), of which Canari
stores the class, never the address; the relay caps each account's new connections and bytes and
refuses with typed close codes; the design ships with it, and the device will never store the school
password ([mail-client](docs/wiki/mail-client.md), [mail-client-transport](docs/wiki/mail-client-transport.md)).
The MiConnect terms move to version 2026-11-28 (the school address to Canari is a new purpose).
