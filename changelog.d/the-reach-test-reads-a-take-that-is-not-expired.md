### Fixed - the take-reach test no longer races the flush failing its second take

The fixture's second take derived its expiry from a `sentAt` long past, so the flush failed its send for good as expired and deleted the row the test was reading; the test now gives it the same far expiry as the first take and waits for both encoders before reading ([testing-methodology](docs/wiki/testing-methodology.md)).
