### Fixed - the "who reacted" list opens on hover or a long press, never on a tap

A tap on a reaction badge (posts and chat) toggled the reaction AND opened the list, because a touch screen synthesises `mouseenter`. A mouse now hovers, a finger holds, and a scroll closes the list ([posts](docs/wiki/frontend/modules/posts.md#the-who-reacted-list-hover-or-long-press-never-a-tap-2026-09-30)).
