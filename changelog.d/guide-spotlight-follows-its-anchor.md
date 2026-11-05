### Fixed - a first-time hint's spotlight stays on its button when the page shifts under it

The ring was measured on size changes and scrolls only, so content settling above a control left it drawn offset; an observer of the control's own box now re-measures on any move, and the ring's corners follow the control's ([guided help](docs/wiki/frontend/guided-help.md)).
