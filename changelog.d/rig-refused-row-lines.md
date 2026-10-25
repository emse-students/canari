### Fixed - the "frames refused for lack of a row" lines stay unexplained unless a row provokes them

The generic epoch rule claimed the new #2414/#2416 lines in every row. They are now tested before it as row-scoped narration (`REFUSED_FOR_LACK_OF_ROW_NARRATION`), so a CC row with no refused frame queued shows them as dirt ([cross-client-testing](docs/wiki/cross-client-testing.md)).
