### Changed - a new device's restore can be measured on both sides

Every accepted commit now logs how long it waited for the MLS mutex and where its hold went (checkpoint, request), every checkpoint names what asked for it, and every profile batch counts the ids asked again - the three lines that decide how to speed up a new device's restore ([the entry](docs/wiki/backlog.d/p2-a-new-device-restore-is-paced-by-one-device-adding-it-group-by-group.md)).
