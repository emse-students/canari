### Changed - TOK-1 reads the commit gate's 201 after a token renewal as the success

TOK-1 on `1.4.1-alpha.4` failed because its needle wanted `200`, while the commit gate answers `201` when it accepts; the line was also left unexplained. The needle now takes 201 or 200 (a duplicate) and nothing else ([cross-client-campaign-1-4-1](docs/wiki/cross-client-campaign-1-4-1.md)).
