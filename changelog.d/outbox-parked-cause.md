### Fixed - a message parked as failed keeps its real cause, and is accused once

A message parked as failed was read back after a start as "5xx on 5 attempts" whatever it had failed on (a native refusal, a "not now"), and every start logged each parked entry again at ERROR. The park now stores its cause as a type, and an entry found already parked is carried forward in one quiet line ([mobile](docs/wiki/frontend/mobile.md)).
