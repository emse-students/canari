### Fixed - a salon handover test waited one tick for WebCrypto

`channelSeal.followerTab.test.ts` now awaits the gate mock's own call instead of a `setTimeout(0)`, which a slow decrypt outran on a loaded runner and leaked into the next test ([testing-methodology](docs/wiki/testing-methodology.md#16-wait-for-the-event-never-for-a-delay---and-a-wait-that-can-end-two-ways-must-assert-the-state-between-them)).
