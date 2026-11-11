#!/usr/bin/env bash
# DOES THE PRE-COMMIT HOOK RE-ADD ONLY WHAT A FIXER CHANGED?
#
# `.husky/pre-commit`'s `restage` used to run one `git add` per staged path. A merge from `main`
# stages several hundred paths, so the index lock was taken several hundred times while an editor's
# own git refresh took it too, and a merge commit failed eight times running on "Unable to create
# index.lock" (2026-11-12). The function now re-adds a staged path only when the worktree differs
# from the index. This runs the hook's OWN function, cut out of the file, against a scratch repo.
#
# Usage: bash .github/scripts/tests/pre-commit-restage.test.sh   (no arguments, no network)
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
hook="$repo_root/.husky/pre-commit"
fn=$(sed -n '/^restage() {/,/^}/p' "$hook")
[ -n "$fn" ] || { echo "FAIL  no restage() function in $hook"; exit 1; }

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"
git init -q .
git config user.email t@t.invalid
git config user.name t
git config core.autocrlf false
mkdir -p pkg
printf 'a\n' > pkg/kept.ts
printf 'b\n' > pkg/fixed.ts
printf 'c\n' > pkg/unstaged.ts
git add pkg
git commit -qm base

fail=0
# Stage two edits; leave a third file dirty but NOT staged.
printf 'a2\n' > pkg/kept.ts
printf 'b2\n' > pkg/fixed.ts
git add pkg/kept.ts pkg/fixed.ts
printf 'c2\n' > pkg/unstaged.ts
export STAGED_FILES
STAGED_FILES=$(git diff --cached --name-only)

# A "fixer" rewrites one staged file only.
printf 'b3\n' > pkg/fixed.ts

# Count the `git add` calls the function makes: a `git` on PATH that logs, then runs the real one.
adds="$scratch/adds"
: > "$adds"
real_git=$(command -v git)
mkdir -p "$scratch/bin"
cat > "$scratch/bin/git" <<SHIM
#!/bin/sh
[ "\$1" = add ] && echo "\$*" >> "$adds"
exec "$real_git" "\$@"
SHIM
chmod +x "$scratch/bin/git"
PATH="$scratch/bin:$PATH"
eval "$fn"
restage pkg

if [ "$(git show :pkg/fixed.ts)" = b3 ]; then echo "  ok    the fixer's rewrite is re-staged"; else echo "  FAIL  the fixer's rewrite is not re-staged"; fail=1; fi
if [ "$(wc -l < "$adds")" -eq 1 ]; then echo "  ok    one git add, for the one file the fixer changed"; else echo "  FAIL  $(wc -l < "$adds") git add calls: $(cat "$adds")"; fail=1; fi
if git diff --cached --name-only | grep -qx pkg/unstaged.ts; then echo "  FAIL  a file the commit never staged was staged"; fail=1; else echo "  ok    a dirty file the commit never staged stays out"; fi

# Nothing changed by the fixer: no git add at all, so no index lock is taken.
: > "$adds"
restage pkg
if [ ! -s "$adds" ]; then echo "  ok    an already-formatted tree takes no lock"; else echo "  FAIL  git add ran on a clean tree: $(cat "$adds")"; fail=1; fi

exit "$fail"
