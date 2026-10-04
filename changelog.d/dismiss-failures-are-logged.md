### Fixed - a lost conversation dismissal is now logged instead of swallowed

`dismissGroup` and `undismissGroup` swallowed their own failures, so the logging `.catch` at every call site never fired; they now throw and every caller logs, and the latent discovery "gap" is closed as consistent by design ([open-questions](docs/wiki/open-questions.md#decision-owed---user_dismissed_group-grows-one-row-per-manual-delete-for-ever)).
