### Added - a form or a question can be reserved to people who do NOT hold a cotisation

The creator picks the tier ("ne detient pas"); the server refuses a holder's answer with
`403 FORM_COTISATION_HELD`, and a paid form no longer renews a tier already held when its payment
lands (recorded `paid_not_granted`, a refund owed), so nobody pays a cotisation twice
([forms](docs/wiki/frontend/modules/forms.md#a-cotisation-not-held-notcotisation-owner-2026-10-30)).
