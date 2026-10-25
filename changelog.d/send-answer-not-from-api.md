### Fixed - a message sent under a captive portal is no longer lost

A `200` that is not the API's JSON (a portal's login page) is now no answer: the message stays pending and goes once the portal ends, and the commit, ACK and Welcome paths read it the same way ([chat](docs/wiki/frontend/modules/chat.md#a-2xx-a-captive-portal-answered-is-no-answer-2026-10-25)).
