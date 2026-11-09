### Changed - the first salon open no longer runs a 60 ms task for a search box nobody opened

The composer's idle emoji warm-up folded the search words of all ~1900 emoji while a salon was opening; they are now folded on first read, and a message with no pictograph no longer builds a grapheme segmenter ([community-open-budget](docs/wiki/frontend/community-open-budget.md#the-composers-idle-warm-up-ran-a-60-ms-task-inside-every-first-open-and-what-is-next-2026-11-09)).
