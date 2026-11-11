### Fixed - a background send behind a captive portal is kept, and an unset internal secret is a 500

The Android background sender no longer counts a 2xx whose body is not JSON as sent; the delivery
services answer their own missing secret with a 500, not a 401; a retried, already-accepted
background Welcome is answered as accepted even when the target's seat now awaits admission
([sessions](docs/wiki/sessions.md#a-401-renews-the-token-and-sends-the-same-request-once---one-rule-every-caller)).
