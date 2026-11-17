### Changed - a message bubble mounts its four closed panels on its first touch, not with the salon

The reaction picker, the info panel, the actions sheet and the delete confirmation are created on a bubble's first `pointerdown` or `focusin`, so a salon open no longer pays their setup for every bubble it draws, and their opening animation still plays ([community-open-budget](docs/wiki/frontend/community-open-budget.md#the-four-closed-overlays-mounted-on-first-intent-2026-11-17)).
