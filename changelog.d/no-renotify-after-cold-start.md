### Fixed - an iPhone no longer re-announces a message its notification extension already showed

A cold start or a resume redelivered messages the extension had presented and the app raised them
again; "already notified" is now a durable record keyed by message id, fed by the app and by the
push-cache entries the system actually presented. The login also seeds its conversation rows before
any frame is let in, and a foreground iPhone banner is titled by its group
([mobile](docs/wiki/frontend/mobile.md#the-ios-half-a-message-is-announced-once-by-id-2026-11-01)).
Out of front, the banner is the page's or the push's, never both: the server makes the ACK and the
deferred push exclusive, and its ACK answer says which won
([mobile](docs/wiki/frontend/mobile.md#out-of-front-the-banner-is-the-pages-or-the-pushs---the-servers-ack-says-which-2026-11-01)).
