### Fixed - an Android call started during a phone call no longer runs with a live microphone

A refused audio focus at the call's start now holds the microphone, and the delayed focus gain released when the phone call ends gives it back with no tap ([calls](docs/wiki/frontend/modules/calls.md)).
