### Fixed - the organiser's grid no longer greys out units the organiser can tap

In block mode the grid drew units inside the minimum notice as closed while a tap on them worked, and the phone's list drew them free. One rule now (`isOfferedStart`) decides both. The edge scroll also stops at the scroll limit and is reset on pointer release
([bookings-chantier](docs/wiki/bookings-chantier.md#the-phones-planning-d55-2026-11-01-owner)).
