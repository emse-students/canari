### Fixed - payer e-mail check bounded against ReDoS, and the guard's alert justified

The Lydia payer e-mail is length-capped and matched by an unambiguous pattern; the regex escape in one test is complete; the `HeaderAuthGuard` bypass alert is a false positive, justified and tested ([nginx](docs/wiki/infrastructure/nginx.md)).
