### Fixed - deleting a form that has answers archives it instead of orphaning its submissions

A form with submissions is now archived (`deletedAt`) and a foreign key forbids a submission naming a missing form; a form with none is still deleted. Migration 081 refuses to run while orphans remain ([forms](docs/wiki/frontend/modules/forms.md#a-form-with-submissions-is-archived-never-removed-2026-10-11)).
