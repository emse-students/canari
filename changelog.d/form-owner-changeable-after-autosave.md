### Fixed - a draft form's association can be changed after its first autosave

The first autosave shut the association picker and the server refused any other value on an edit; a draft now moves when its actor is a member of both associations, applied at its publication, while a published form keeps its association and says why ([forms](docs/wiki/frontend/modules/forms.md#a-drafts-association-may-change-a-published-forms-may-not-owner-2026-11-09)).
