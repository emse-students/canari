# shellcheck shell=bash
#
# THE OWNER'S HOLD ON A MIGRATION - which files need the owner's approval, and whether they have it.
#
# WHY (owner, 2026-11-01: "a migration is applied only if it is additive, reviewed, and with a backup
# taken just before"). Migrations 034, 038 and 042 were each written as "owed the owner's yes" and
# reached production with the next release anyway: the yes was a sentence in the backlog, and
# `apply_migrations` applies every unrecorded file. A held migration is now REFUSED until a committed
# line approves it. Two readers ask the same question of the same files through this ONE library:
#
#   - `apply_migrations` (infrastructure/lib/migrations.sh), on every deploy and every dev reset,
#     for the files the ledger has not recorded - the last line of defence;
#   - `release-preflight.sh`, for the files a release adds since the latest stable - so a tag that
#     carries a held, unapproved migration is refused BEFORE the bump and the store builds.
#
# WHAT HOLDS A MIGRATION, AND WHY IT IS AN ALLOWLIST. A file is held when
#
#   - it carries the marker: a line `-- canari:hold-for-owner` (any case, leading space allowed,
#     trailing text allowed - `-- canari:hold-for-owner: the backfill of 2026-11-02`), written by the
#     author of anything the owner must see (a backfill, a lock on a hot table);
#   - or its SQL - comments stripped, strings kept, whitespace collapsed - contains a statement that
#     is not plainly additive: ANY `DROP` except `DROP CONSTRAINT|INDEX|TRIGGER|DEFAULT|NOT NULL`
#     (the re-create idiom and a relaxed column), any `RENAME`, `TRUNCATE`, `DELETE FROM`, a column
#     `TYPE` change (`ALTER [COLUMN] x [SET DATA] TYPE`), and `EXECUTE` of dynamic SQL (whose text
#     no reader can judge; `EXECUTE FUNCTION|PROCEDURE` of a trigger and `GRANT EXECUTE ON` are not
#     dynamic SQL). An `UPDATE` backfill is NOT matched: it is the author's to mark.
#
# The destructive list was a DENYLIST of spellings first (`DROP TABLE|COLUMN`) and a review found the
# spellings it walked past - `ALTER TABLE t DROP foo`, `DROP TYPE ... CASCADE`, a materialized view,
# a sequence, `DROP OWNED`, `RENAME COLUMN`, a statement split over lines. So `DROP` is held by
# default and only the four additive forms are let through.
#
# COMMENTS ARE STRIPPED BY A SCANNER THAT KNOWS STRINGS. A `--` inside a string literal is not a
# comment, and stripping from it would eat the code after it. The scanner follows '...' (with ''
# and E'\'' escapes), "..." identifiers, `--` and nested `/* */` comments. An unterminated string or
# comment is a file it cannot read, and a file it cannot read is HELD (fail closed), never plain.
# Dollar-quoted bodies (`DO $$ ... $$`) are scanned as code: their content IS the SQL that runs.
#
# THE APPROVAL is a committed line `<repo-relative path> <sha256 of the file>` in
# MIGRATION_APPROVALS_FILE. It is bound to the CONTENT, so a file edited after its approval is held
# again; and a pull request that touches that file is NEVER armed for auto-merge
# (`arm-auto-merge.yml`), so the line reaches `main` only by the owner's own merge. A release has no
# input to carry an approval (`gh release create` takes none), and an environment flag would be a
# switch nobody reviews.
#
# Callers run from the repository root (paths are repo-relative). Mechanism and history:
# docs/wiki/cicd.md, "A migration the owner must approve is held".

readonly MIGRATION_APPROVALS_FILE='infrastructure/migration-approvals.txt'

# The marker, read by ONE grep on the file - no pipe, so no early-closing reader can turn a match on
# a large file into a SIGPIPE'd "no match" under pipefail (measured: 30 misses in 30 above ~64 KB
# when it was `tr | grep -q`). `[^a-z0-9_-]|$` lets trailing text and a CRLF `\r` follow it.
readonly MIGRATION_HOLD_MARKER_PATTERN='^[[:space:]]*--[[:space:]]*canari:hold-for-owner([^a-z0-9_-]|$)'

# Prints the SQL of file $1 on ONE line, upper-cased, comments removed, whitespace collapsed to one
# space. Exits non-zero (and prints nothing useful) when a string or a comment never closes.
migration_sql_normalized() {
  awk '
    BEGIN { state = 0; depth = 0; last = " " }
    function emit(s) {
      if (s ~ /^[ \t\r\f\v]$/) { if (last != " ") { printf " "; last = " " } return }
      printf "%s", toupper(s); last = s
    }
    {
      line = $0; n = length(line); i = 1
      while (i <= n) {
        c = substr(line, i, 1); d = substr(line, i + 1, 1)
        if (state == 0) {
          if (c == "-" && d == "-") { i = n + 1; continue }
          if (c == "/" && d == "*") { state = 3; depth = 1; i += 2; emit(" "); continue }
          if (c == "\047") {
            p = substr(line, i - 1, 1); q = substr(line, i - 2, 1)
            esc = ((p == "E" || p == "e") && q !~ /[A-Za-z0-9_$]/) ? 1 : 0
            state = 1; emit(c); i++; continue
          }
          if (c == "\"") { state = 2; emit(c); i++; continue }
          emit(c); i++; continue
        }
        if (state == 1) {
          if (esc && c == "\\") { emit(c); emit(d); i += 2; continue }
          if (c == "\047" && d == "\047") { emit(c); emit(d); i += 2; continue }
          if (c == "\047") { state = 0 }
          emit(c); i++; continue
        }
        if (state == 2) {
          if (c == "\"" && d == "\"") { emit(c); emit(d); i += 2; continue }
          if (c == "\"") { state = 0 }
          emit(c); i++; continue
        }
        # state 3: a block comment, which PostgreSQL nests
        if (c == "/" && d == "*") { depth++; i += 2; continue }
        if (c == "*" && d == "/") { depth--; i += 2; if (depth == 0) { state = 0 } continue }
        i++
      }
      emit(" ")
    }
    END { printf "\n"; if (state != 0) exit 3 }
  ' "$1"
}

# Prints why the migration file $1 needs the owner's approval, or nothing when it does not. Returns
# 2, with an ::error:: on stderr, when the file cannot be read or scanned - never "nothing".
migration_hold_reason() {
  local migration="$1" sql match found=""
  grep -qiE "$MIGRATION_HOLD_MARKER_PATTERN" "$migration"
  case $? in
  0)
    printf 'it carries the hold marker'
    return 0
    ;;
  1) ;;
  *)
    printf '::error::%s could not be read to decide whether it is held\n' "$migration" >&2
    return 2
    ;;
  esac

  if ! sql="$(migration_sql_normalized "$migration")"; then
    printf 'its SQL could not be scanned (an unterminated string or comment) - held, not guessed'
    return 0
  fi

  while IFS= read -r match; do
    [ -z "$match" ] && continue
    case "$match" in
    'DROP CONSTRAINT'* | 'DROP INDEX'* | 'DROP TRIGGER'* | 'DROP DEFAULT'* | 'DROP NOT NULL'*) continue ;;
    'EXECUTE FUNCTION'* | 'EXECUTE PROCEDURE'* | 'EXECUTE ON'*) continue ;;
    esac
    case ", $found, " in *", $match, "*) continue ;; esac
    found="${found:+$found, }$match"
  done < <(grep -oE '\bDROP\b( [A-Z_"]+)?( [A-Z_"]+)?|\bRENAME\b( [A-Z_"]+)?|\bTRUNCATE\b|\bDELETE FROM\b|\bALTER (COLUMN )?("[^"]*"|[A-Z_][A-Z_0-9]*) (SET DATA )?TYPE\b|\bEXECUTE\b( [A-Z_]+)?' <<<"$sql")

  if [ -n "$found" ]; then
    printf 'it contains a statement that is not plainly additive (%s)' "$found"
  fi
}

# Prints the verdict on migration file $1 as ONE line, fields separated by `|`:
#   plain                                   - not held
#   approved|<sha256>|<reason>              - held, and approved for this exact content
#   held|<sha256>|<reason>                  - held, and no line approves it
#   stale|<sha256>|<approved sums>|<reason> - held, and approved only for another content
# Returns non-zero, with an ::error:: on stderr, when it cannot decide.
migration_gate_verdict() {
  local migration="$1" reason checksum approved
  reason="$(migration_hold_reason "$migration")" || return 1
  if [ -z "$reason" ]; then
    printf 'plain\n'
    return 0
  fi
  if ! checksum="$(sha256sum "$migration")"; then
    printf '::error::%s could not be hashed\n' "$migration" >&2
    return 1
  fi
  checksum="${checksum%% *}"
  approved=""
  if [ -f "$MIGRATION_APPROVALS_FILE" ]; then
    approved="$(awk -v f="$migration" '{ sub(/\r$/, "") } $1 == f { print tolower($2) }' "$MIGRATION_APPROVALS_FILE")" || {
      printf '::error::%s could not be read\n' "$MIGRATION_APPROVALS_FILE" >&2
      return 1
    }
  fi
  if grep -qxF "$checksum" <<<"$approved"; then
    printf 'approved|%s|%s\n' "$checksum" "$reason"
  elif [ -n "$approved" ]; then
    printf 'stale|%s|%s|%s\n' "$checksum" "$(printf '%s' "$approved" | tr '\n' ' ' | sed 's/ $//')" "$reason"
  else
    printf 'held|%s|%s\n' "$checksum" "$reason"
  fi
}

# The remedy, written ONCE for both readers. A rerun of the same release does not help: it resets to
# the release's own commit, which does not carry an approval merged after it.
migration_hold_remedy() { # <file> <sha256>
  printf '::error::to apply it, the OWNER - once it is additive or its loss is accepted, and reviewed - merges the line "%s %s" into %s by hand (such a pull request is never armed for auto-merge), then cuts a NEW pre-release tag. Re-running this release does not help: it re-reads its own commit.\n' \
    "$1" "$2" "$MIGRATION_APPROVALS_FILE"
}
