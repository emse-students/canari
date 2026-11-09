### Fixed - a long press on a message opens the menu only, and its actions fit on one row of icons

On a phone, the text inside a bubble was `select-text` and overrode the bubble's `select-none`, so iOS selected a word and showed its handles next to the action sheet; on a coarse pointer the text is now neither selectable nor given a callout ("Copier" stays in the sheet). The sheet's actions are icons on ONE row (name kept as aria-label and tooltip) instead of wrapping onto a second one ([chat](docs/wiki/frontend/modules/chat.md)).
