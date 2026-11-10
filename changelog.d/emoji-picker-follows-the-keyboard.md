### Fixed - the reaction picker no longer sits under the keyboard for seconds when its search is focused

Floating panels followed only the layout viewport, which Android resizes for the keyboard late (and a phone browser never); they now follow the visual viewport through the keyboard store's one measurement ([mobile](docs/wiki/frontend/mobile.md#a-floating-panel-follows-the-keyboard-from-the-visual-viewport-2026-11-10)).
