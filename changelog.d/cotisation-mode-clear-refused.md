### Fixed - an association can no longer clear its cotisation while members-only products or cards need it

Clearing the cotisation mode is now refused (`409 COTISATION_MODE_IN_USE`) while an active product or
partnership card is reserved to cotisants, instead of leaving rows nobody can buy; the clear and the
members-only saves are ordered on the association row
([cotisations](docs/wiki/cotisations.md#product-member-gating--pricing)).
