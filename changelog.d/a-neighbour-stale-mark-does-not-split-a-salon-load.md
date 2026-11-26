### Fixed - a salon declared stale no longer splits the history load of another salon

The stale counter that decides whether a second load joins the one in flight is per salon, so opening a salon while a neighbour is invalidated asks for one page, not two ([community-open-budget](docs/wiki/frontend/community-open-budget.md)).
