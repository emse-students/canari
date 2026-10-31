### Fixed - the iPhone header pill draws the placeholder gradient again

The native glass header's avatar bitmap read a background colour the gradient placeholders (#2776) no longer have, so it showed bare or white-on-white initials. It now paints the same gradient from the `app.css` tokens ([design-reference](docs/wiki/frontend/design-reference.md)).
