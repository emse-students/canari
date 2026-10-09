### Fixed - on a weak link a stalled request no longer hangs for ever, and one stalled send no longer freezes every other message

Every REST call and the MLS send POST now give up when no answer arrives (20 s reads, 30 s writes plus the time the body needs to leave), as a typed transport failure that never logs anyone out. A calm "Connexion lente" strip shows when answers are measurably slow, and the outbox drains one lane per conversation so one dead POST holds only its own conversation, in order ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md)).
