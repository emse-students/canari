### Added - the mail client's transport (lot 1), switched off

A TLS client in WASM for the school mailbox, a blind relay on chat-gateway for eligible accounts
(off unless `MAIL_RELAY_ENABLED`), a native socket for the apps, and HTTP/1.1 + Zimbra SOAP on top.
Eligibility is MiConnect's new `school_mail` claim (CAS accounts, Canari only), of which Canari
stores the class, never the address; nothing a user sees yet
([mail-client-transport](docs/wiki/mail-client-transport.md)).
