### Fixed - no payment is opened that a disabled cotisation or a tagless product could never grant

A paid form that grants a cotisation is refused `409 COTISATION_DISABLED` before its payment opens while the association has no cotisation mode, and a grant meeting that state at settlement is final (`paid_not_granted`), never retried. The boutique refuses a legacy membership product that stores no tag at the checkout. Both ask ONE check, `cotisationGrantRefusal` ([cotisations](docs/wiki/cotisations.md)).
