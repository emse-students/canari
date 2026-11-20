### Fixed - a rename notice no longer fires for a name that only differs by a trailing space

A server group name written untrimmed by an old build made an honest sealed-name statement draw a rename notice naming its sender; names are now compared trimmed ([sealed-names](docs/wiki/protocols/sealed-names.md)). The live replay switch-off tests now prove the bell rows are purged and that overlapping switch-offs run exactly one drain.
