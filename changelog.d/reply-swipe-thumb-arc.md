### Fixed - a reply swipe drawn armed now replies, even along a thumb's arc

A release with 42 px or more of vertical drift was silently refused while the bubble already showed the armed icon; the release now uses the same rule the bubble paints from ([design-reference](docs/wiki/frontend/design-reference.md#the-reply-swipe-that-sometimes-did-nothing-two-classes-measured-mi-9t-2026-10-14)).
