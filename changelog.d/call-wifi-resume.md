### Fixed - a network blip no longer ends a 1:1 call (CALL-WIFI)

A dropped signalling socket now resumes its seat and the initiator restarts ICE; only a hangup, a refused resume or a spent attempt budget ends the call ([calls](docs/wiki/frontend/modules/calls.md#a-network-blip-does-not-end-the-call-call-wifi-2026-10-19)).
