## Reading owed - the auto-merge ceiling refuses a major

target: 1.7.0

**What is built:** the auto-merge ceiling refuses a major

**The reading that closes it:** the workflow logging `REFUSED` on a real major in its own run: read the `Dependency ceiling` log of a CURRENT open major

**Checked 2026-11-14: no open major of a ceiling entry.** Two semver majors merged through the
auto-merge as designed (#3480 `setup-rust-toolchain` 1 to 2, #3257 `paraglide-js` 2 to 3): the
ceiling is not semver - it refuses only the names of `.github/scripts/lib/ceiling.sh` (a datastore
major such as `postgres`), whose own tests cover the refusal. The reading waits for Dependabot to
open such a major.
