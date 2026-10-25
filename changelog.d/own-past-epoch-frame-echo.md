### Fixed - a device's own frame from a past epoch is an own echo, not a lost message

A frame this device sent, delivered back to it after the group moved on, was counted as a loss and started a reconcile; the envelope now identifies it before MLS is asked, and it is acknowledged with one line ([mls-protocol](docs/wiki/protocols/mls-protocol.md#our-own-frame-from-a-past-epoch-was-called-a-loss-2026-10-25)).
