### Fixed - a Back to the feed reopens the tab the reader left, not the one chosen last

A feed address with no `?feed=` reopened on the tab chosen most recently, so a Back after leaving "Organisations" could land on "Pour toi" at the top. The feed now writes the tab it draws into its own address, and the anchor restore runs against that list ([section-navigation](docs/wiki/frontend/section-navigation.md)). Not yet read on a phone.
