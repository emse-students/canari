### Fixed - a form's options rule each other out the same way whatever the order of the clicks

The editor and the server now read one shared rule for which options exclude each other, so switching "Formulaire public" on before or after another option gets the same answer, and the server refuses an incoherent form with a code. A public form may now carry a price grid by promo, formation or cotisation: a guest pays the "autres" tier. Rule table: [forms](docs/wiki/frontend/modules/forms.md#which-options-rule-each-other-out-one-rule-in-either-order-2026-11-06).
