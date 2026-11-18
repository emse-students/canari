### Fixed - an association's Lydia payments becoming ready no longer logs a warning

A Business marked ready by Lydia's webhook was logged at WARN with "before: nothing recorded at no date" and the switched-off managers' notice as if it were a fault. The designed transition is now an INFO line saying what it was before and that the notices are off by switch; the revert stays an ERROR ([payments](docs/wiki/frontend/modules/payments.md#readiness-one-writer-and-lydias-own-refusal-reverts-it-enrolment-lot-2)).
