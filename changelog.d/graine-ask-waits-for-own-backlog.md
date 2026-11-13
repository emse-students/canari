### Fixed - a missing salon seed is asked of a peer only after this device's own backlog is in

A salon opened from its banner on resume asked other members for seeds that were already queued on
the device, and could send the same request twice; the ask now waits for the key group to be drained
and is marked before its send ([channel-encryption 4.5](docs/wiki/protocols/channel-encryption.md#45-a-missing-seed-is-requested-and-said-out-loud)).
