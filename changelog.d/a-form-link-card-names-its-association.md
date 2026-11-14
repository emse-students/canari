### Fixed - a form's link card says which association it belongs to

`GET /api/forms/:id` now carries `associationName` like the list does (the same lookup), so the card
reads "Ouvert · BDE" instead of "Ouvert" (`frontend/src/lib/utils/canariLinkPreview.ts`).
