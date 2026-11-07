### Changed - the price grid's exhaustive cent round trip runs in ten slices

The test that sends every accepted amount (0 to 1 000 000 cents) through the euro input and back took about a second in one case, and timed out once on a loaded machine. It still checks every amount, now in ten cases of 100 000, each well under the per-test budget. See [forms](docs/wiki/frontend/modules/forms.md).
