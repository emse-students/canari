### Changed - the end of the register asks is said at error

Every build at the `1.7.0` floor answers or declines `register`, so five unanswered asks are a defect: the bound stays, its line is raised from warn to error ([legacy-compatibility](docs/wiki/legacy-compatibility.md#entries-170-retires-the-floor-raise-of-both-estates-once-both-stores-serve-170)). A device withholding history from an unvouched asker now declines it as `'withheld'`, so that normal state ends at info, named ([history-answer-addressing](docs/wiki/protocols/history-answer-addressing.md)).
