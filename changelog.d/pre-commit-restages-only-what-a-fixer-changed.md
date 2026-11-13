### Fixed - the pre-commit hook re-stages only the files a fixer changed

It ran one `git add` per staged path, so a merge from `main` took the index lock hundreds of times and lost the race to an editor's git refresh ("Unable to create index.lock"). The comment in `.husky/pre-commit` and `.github/scripts/tests/pre-commit-restage.test.sh` carry the detail.
