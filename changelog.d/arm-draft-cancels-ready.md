### Fixed - a draft event could cancel the auto-merge arming

A push and `gh pr ready` in the same second let the draft run, which skips, cancel the run that
would have armed, and #1259 sat green and unmerged. The concurrency group now carries the draft
flag, in all four repositories ([cicd](docs/wiki/cicd.md)).
