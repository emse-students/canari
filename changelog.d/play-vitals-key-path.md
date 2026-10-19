### Fixed - the Play vitals key is read from the harness state directory

`tools/play-vitals` looked one directory too shallow; the default is now the harness state directory, `PLAY_SA_KEY` still overrides, and a missing key names both ([play-vitals](tools/play-vitals/README.md)).
