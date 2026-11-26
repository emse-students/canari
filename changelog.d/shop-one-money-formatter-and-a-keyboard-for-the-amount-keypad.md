### Changed - one money formatter, and the shop's amount keypad takes the physical keyboard

`formatAmount` now delegates to `formatAmountCents`, the admin purchase and form price lines use it
instead of `toFixed(2)`, and the "Autre montant" keypad takes digits, `,`/`.` and Backspace once
focused, each picker listening on its own element ([shop](docs/wiki/cotisations.md)).
