### Changed - DUP-2 is PASS-DIRTY on a product race: a joiner gets the next commit before its late Welcome

DUP-2 on `1.4.1-alpha.4` held every assertion. But the joiner of an Add whose answer was lost received the next commit before its Welcome, asked for a re-Add it did not need, and then re-read a frame live delivery had already read ([backlog](docs/wiki/backlog.md)).
