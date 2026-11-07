### Changed - unused exports of 37 frontend files are no longer exported

About 90 exports and exported types that nothing imports lose their `export`, eight with nothing left in the file are deleted, files that are declared copies or pinned by a source-reading test are declared to the tool instead, and the dead-code baseline drops by 112 ([dead-code](docs/wiki/dead-code.md)).
