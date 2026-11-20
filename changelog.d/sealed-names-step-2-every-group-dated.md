### Changed - every group's name is dated by its members, silently

A new group dates its name at creation, and a group that existed before is restated once by one member device, by a `groupNamed` frame that stays silent unless it changes the name shown; a rename always beats such a statement, so a restatement crossing a real rename never puts the old name back ([sealed-names](docs/wiki/protocols/sealed-names.md#step-2---built-2026-11-20-every-group-gets-a-dated-name)).
