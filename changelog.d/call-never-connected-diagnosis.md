### Fixed - a call that never connected is said on the screen, written as not connected, and diagnosable

A 1:1 call answered but never connected showed "Connexion..." while the other party was gone and was
recorded as answered: the screen now says "<name> a perdu la connexion...", the record reads
"Appel non abouti" with a call-back button, and `[CALL_REPORT]` counts the ICE candidates each way
while the relay's `PeerAway` says how the other socket ended
([calls](docs/wiki/frontend/modules/calls.md#a-call-that-never-connected-is-said-and-written-so-2026-11-22)).
