### Fixed - a salon opened on a cold start no longer warns "missing seed" for seeds its key group was still draining

Its page is now decoded only after the key group's drain proof (`whenSalonKeysDrained`), never beside
it, so a row reads with the seed the drain brought on the first open
([channel-encryption 4.5](docs/wiki/protocols/channel-encryption.md#45-a-missing-seed-is-requested-and-said-out-loud)).
