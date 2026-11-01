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
#   - or it contains a UTF-8 byte-order mark anywhere: one before `--` hides the marker from the
#     line match above, so a file carrying one is held, never guessed;
#   - or its SQL - comments stripped, strings kept, whitespace collapsed, then cut into TOKENS -
#     contains a statement that is not plainly additive: ANY `DROP` except `DROP CONSTRAINT`,
#     `DROP DEFAULT`, `DROP NOT NULL` and `DROP INDEX|TRIGGER <name>` (the re-create idiom and a
#     relaxed column), any `RENAME`, `TRUNCATE`, `DELETE FROM`, a column `TYPE` change
#     (`ALTER [COLUMN] x [SET DATA] TYPE`), and `EXECUTE` of dynamic SQL (whose text no reader can
#     judge; `EXECUTE FUNCTION|PROCEDURE <name>(` of a trigger and `GRANT EXECUTE ON FUNCTION` are
#     not dynamic SQL). An `UPDATE` backfill is NOT matched: it is the author's to mark.
#
# The destructive list was a DENYLIST of spellings first (`DROP TABLE|COLUMN`) and a review found the
# spellings it walked past - `ALTER TABLE t DROP foo`, `DROP TYPE ... CASCADE`, a materialized view,
# a sequence, `DROP OWNED`, `RENAME COLUMN`, a statement split over lines. So `DROP` is held by
# default and only the additive forms are let through. The second version matched those forms as
# string PREFIXES, and its review walked past them by naming a column after one: `DROP indexed_at`,
# `DROP default_role`, `DROP trigger_count`, `EXECUTE on_cmd` (a PL/pgSQL variable). So the forms
# are matched on WHOLE TOKENS now, and `INDEX` and `TRIGGER` - which PostgreSQL also accepts as
# column names (`ALTER TABLE t DROP index` drops the column `index`) - pass only when a name that is
# not `CASCADE` or `RESTRICT` follows them.
#
# COMMENTS ARE STRIPPED BY A SCANNER THAT KNOWS STRINGS. A `--` inside a string literal is not a
# comment, and stripping from it would eat the code after it. The scanner follows '...' (with ''
# and E'\'' escapes), "..." identifiers, `--` and nested `/* */` comments, and dollar quotes
# (`$$ ... $$`, `$tag$ ... $tag$`). An unterminated string, comment or dollar quote is a file it
# cannot read, and a file it cannot read is HELD (fail closed), never plain.
#
# A DOLLAR-QUOTED BODY IS KEPT VERBATIM, comments and all. It may be a function body or a `DO` block,
# whose content IS the SQL that runs, or a plain literal - and no reader of the outer text can tell
# which, nor where a comment inside it ends (`SELECT $x$ -- $x$; DROP TABLE t;` closes the quote
# before the `--` ends anything; the first lexer here stripped from the `--` and called that plain).
# So nothing inside a body is ever stripped: a `DROP` in a comment of a body holds the file, which
# costs the author a marker-free rewrite or the owner's line, and can never let a statement through.
#
# THE APPROVAL is a committed line `<repo-relative path> <sha256 of the file>` in
# MIGRATION_APPROVALS_FILE. It is bound to the CONTENT, so a file edited after its approval is held
# again; and a pull request that touches that file - or this one - is NEVER armed for auto-merge
# (`arm-auto-merge.yml`), so the line never reaches `main` by automation (a writer can still merge it
# by hand, a risk the owner accepted on 2026-11-01). A release has no input to carry an approval
# (`gh release create` takes none), and an environment flag would be a switch nobody reviews.
#
# Callers run from the repository root (paths are repo-relative). Mechanism and history:
# docs/wiki/cicd.md, "A migration the owner must approve is held".

readonly MIGRATION_APPROVALS_FILE='infrastructure/migration-approvals.txt'

# The marker, read by ONE grep on the file - no pipe, so no early-closing reader can turn a match on
# a large file into a SIGPIPE'd "no match" under pipefail (measured: 30 misses in 30 above ~64 KB
# when it was `tr | grep -q`). `[^a-z0-9_-]|$` lets trailing text and a CRLF `\r` follow it.
readonly MIGRATION_HOLD_MARKER_PATTERN='^[[:space:]]*--[[:space:]]*canari:hold-for-owner([^a-z0-9_-]|$)'

# Prints the SQL of file $1 on ONE line, upper-cased, comments removed, whitespace collapsed to one
# space, every dollar-quote delimiter set apart by a space on each side (so `$x$DROP` cannot glue the
# keyword to the tag). Exits non-zero (and prints nothing useful) when a string, a comment or a
# dollar quote never closes. Byte-wise (`LC_ALL=C`), so a multi-byte character is never split
# differently on two hosts.
migration_sql_normalized() {
  LC_ALL=C awk '
    BEGIN { state = 0; depth = 0; last = " "; dtag = "" }
    function emit(s) {
      if (s ~ /^[ \t\r\f\v]$/) { if (last != " ") { printf " "; last = " " } return }
      printf "%s", toupper(s); last = s
    }
    {
      line = $0; n = length(line); i = 1
      while (i <= n) {
        c = substr(line, i, 1); d = substr(line, i + 1, 1)
        if (state == 4) {
          # A dollar-quoted body: kept verbatim until ITS closing tag, whatever it contains.
          if (substr(line, i, length(dtag)) == dtag) {
            emit(" "); emit(dtag); emit(" "); i += length(dtag); state = 0; continue
          }
          emit(c); i++; continue
        }
        if (state == 0) {
          # A dollar quote opens on `$tag$` or `$$` - not inside an identifier (`a$b$`), which
          # PostgreSQL reads as one name, and not on a parameter (`$1`).
          if (c == "$" && substr(line, i - 1, 1) !~ /[A-Za-z0-9_$]/ &&
              match(substr(line, i), /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)) {
            dtag = substr(line, i, RLENGTH)
            emit(" "); emit(dtag); emit(" "); i += RLENGTH; state = 4; continue
          }
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
  local migration="$1" sql found
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

  LC_ALL=C grep -q $'\xEF\xBB\xBF' "$migration"
  case $? in
  0)
    printf 'it contains a UTF-8 byte-order mark, which hides a hold marker on its line - held, not guessed'
    return 0
    ;;
  1) ;;
  *)
    printf '::error::%s could not be read to decide whether it is held\n' "$migration" >&2
    return 2
    ;;
  esac

  if ! sql="$(migration_sql_normalized "$migration")"; then
    printf 'its SQL could not be scanned (an unterminated string, comment or dollar quote) - held, not guessed'
    return 0
  fi

  found="$(migration_unplain_statements <<<"$sql")"
  if [ -n "$found" ]; then
    printf 'it contains a statement that is not plainly additive (%s)' "$found"
  fi
}

# Reads the ONE normalized line of `migration_sql_normalized` on stdin and prints, comma-separated
# and each once, the statements in it that are not plainly additive - nothing when there is none.
# It cuts the line into TOKENS first (a word, a "quoted identifier", or one punctuation character)
# and judges each keyword by the WHOLE tokens after it: a prefix match is what let `DROP indexed_at`
# through as `DROP INDEX` (review of #2873). A word may hold `$` after its first character, as a
# PostgreSQL identifier does; the dollar-quote delimiters arrive already set apart by spaces.
migration_unplain_statements() {
  LC_ALL=C awk '
    function isname(t) { return t ~ /^[A-Z0-9_][A-Z0-9_$]*$/ || t ~ /^".*"$/ }
    function report(s) { if (!(s in seen)) { seen[s] = 1; out = out (out == "" ? "" : ", ") s } }
    {
      s = $0; n = length(s); i = 1; k = 0
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == " ") { i++; continue }
        if (c == "\"") {
          j = i + 1
          while (j <= n) {
            if (substr(s, j, 1) == "\"") { if (substr(s, j + 1, 1) == "\"") { j += 2; continue } break }
            j++
          }
          tok[++k] = substr(s, i, j - i + 1); i = j + 1; continue
        }
        if (c ~ /[A-Z0-9_]/) {
          j = i + 1
          while (j <= n && substr(s, j, 1) ~ /[A-Z0-9_$]/) j++
          tok[++k] = substr(s, i, j - i); i = j; continue
        }
        tok[++k] = c; i++
      }
      for (m = 1; m <= k; m++) {
        t = tok[m]; a = tok[m + 1]; b = tok[m + 2]; c = tok[m + 3]
        if (t == "DROP") {
          if (a == "CONSTRAINT" || a == "DEFAULT") continue
          if (a == "NOT" && b == "NULL") continue
          if (a == "INDEX" || a == "TRIGGER") {
            j = m + 2
            if (tok[j] == "CONCURRENTLY") j++
            if (tok[j] == "IF" && tok[j + 1] == "EXISTS") j += 2
            if (isname(tok[j]) && tok[j] != "CASCADE" && tok[j] != "RESTRICT") continue
          }
          report("DROP" (isname(a) ? " " a (isname(b) ? " " b : "") : ""))
        } else if (t == "RENAME") {
          report("RENAME" (isname(a) ? " " a : ""))
        } else if (t == "TRUNCATE") {
          report("TRUNCATE")
        } else if (t == "DELETE" && a == "FROM") {
          report("DELETE FROM")
        } else if (t == "ALTER") {
          j = m + 1
          if (tok[j] == "COLUMN") j++
          if (!isname(tok[j])) continue
          j++
          if (tok[j] == "SET" && tok[j + 1] == "DATA") j += 2
          if (tok[j] == "TYPE") report("ALTER " tok[j - 1 - (tok[j - 1] == "DATA" ? 2 : 0)] " TYPE")
        } else if (t == "EXECUTE") {
          if (a == "ON" && b ~ /^(FUNCTION|FUNCTIONS|PROCEDURE|PROCEDURES|ROUTINE|ROUTINES|ALL)$/) continue
          if ((a == "FUNCTION" || a == "PROCEDURE") && isname(b) && b != "USING" && b != "INTO" && (c == "(" || c == ".")) continue
          report("EXECUTE" (isname(a) ? " " a : ""))
        }
      }
    }
    END { print out }
  '
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
