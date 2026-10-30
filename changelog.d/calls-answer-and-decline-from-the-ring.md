### Fixed - an answer from the native ring joins the call, and a decline from it reaches the caller

A closed phone never received the caller's invite, so Answer waited for it and the call rang out; it now joins on the ring's own facts, carried by a private intent and acted on once the session has caught up, and Decline sends the in-app hangup. The room token is refused once the server recorded the ring as ended ([calls](docs/wiki/frontend/modules/calls.md#an-answer-from-the-ring-joins-on-the-rings-facts-2026-10-30)).
