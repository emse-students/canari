### Fixed - a cut reply quote ends with an ellipsis, and a mouse resting on a reaction shows who reacted

The stored quote was cut at 100 RAW characters, where an `@[id]` mention weighs ~40 but draws short, so it escaped the display's ellipsis; the cut is now marked where it is made. A desktop mouse opens the "who reacted" list after a short rest (a touch keeps the hold) - [posts](docs/wiki/frontend/modules/posts.md#the-who-reacted-list-a-tap-reacts-a-hold-shows-who---discords-gesture-2026-10-01).
