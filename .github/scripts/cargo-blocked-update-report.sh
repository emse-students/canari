#!/usr/bin/env bash
#
# THE NAMED TRIGGER FOR THE CARGO DIRECTORIES DEPENDABOT CANNOT REACH.
#
# THE DECISION THIS IMPLEMENTS (user, 2026-09-10): keep `/frontend/src-tauri` and its custom-tabs
# plugin declared to Dependabot, and update them deliberately behind a mechanism - option 3 of the
# three in `docs/wiki/backlog.md`. Option 1 (drop the `links` key) is REFUTED: `links` is what makes
# cargo export a build script's metadata to dependents, and `tauri-build` needs it to find the
# plugin's Kotlin - drop it and `open_custom_tab` fails at runtime on a phone while everything
# builds green. Option 2 (undeclare the directories) makes the artefact that ships to phones
# permanently unmanaged, which is what *"un projet qui peut vivre tout seul"* is against.
#
# **"SOMEBODY REMEMBERS" IS NOT A MECHANISM**, and that is the whole content of option 3. This
# script is the remembering.
#
# WHY THE REPORT IS AN ISSUE AND NOT A RED RUN, which is a deliberate departure from its neighbour
# `dependabot-alerts-report.sh`. An open security alert is an anomaly, so it makes that run red. A
# cargo dependency being one patch behind is the NORMAL state of any Rust tree: a red nightly for it
# would be red every night, and *a line its reader learns to skip is the one that hides the next
# defect*. So the split is by meaning - **the issue says there is work, a red run says this reporter
# is broken.** Nothing else may turn it red.
#
# IDEMPOTENCE COMES FROM DURABLE STATE, NEVER FROM A CLOCK: the issue is found by an exact title and
# UPDATED, so a weekly cron cannot accumulate a pile of them. And when the updates are gone the
# issue is CLOSED with a comment saying so, because an issue nobody closes is the queue nobody
# drains that this repository refuses everywhere else.
#
# THE FOUR WAYS AN EMPTY ANSWER CAN LIE, all of which fail rather than report "nothing to update":
# the derivation returning no directories (a broken parse reads exactly like a healthy config),
# `cargo` missing, `cargo` refusing a manifest, and `gh` unable to reach the API.
#
# Usage: .github/scripts/cargo-blocked-update-report.sh
# Env:   GH_TOKEN (required by gh), REPO (default: $GITHUB_REPOSITORY)
#        REPO_ROOT, CARGO, GH - overridden by the self-test only.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$HERE/../.." && pwd)}"
CARGO="${CARGO:-cargo}"
GH="${GH:-gh}"
REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
CONFIG="$REPO_ROOT/.github/dependabot.yml"

# The issue's identity. It is matched EXACTLY, so it must never carry a count, a date or a version -
# a title that moves is a title that opens a second issue.
readonly ISSUE_TITLE='Cargo updates for the directories Dependabot cannot reach'

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/cargo-dirs.sh
source "$HERE/lib/cargo-dirs.sh"

die() {
  echo "::error::$1"
  exit 1
}

[ -n "$REPO" ] || die "REPO is unset and GITHUB_REPOSITORY is empty - this reporter does not know which repository to file against."
[ -f "$CONFIG" ] || die "$CONFIG is not in the tree, so no directory can be derived."

# --- 1. which directories, derived rather than named ----------------------------------------------

blocked="$(blocked_cargo_dirs "$REPO_ROOT" "$CONFIG")"
if [ -z "$blocked" ]; then
  # NOT A PASS. Either every directory became reachable - in which case Dependabot handles them and
  # this whole mechanism should be deleted, deliberately - or the parse broke. Both need a human,
  # and `dependabot-cargo-reach.test.sh` is the test that tells them apart.
  die "no blocked cargo directory was derived. Either the \`links\` blockage is GONE (delete this job and its backlog entry) or the derivation in lib/cargo-dirs.sh is broken. dependabot-cargo-reach.test.sh distinguishes the two."
fi

command -v "$CARGO" >/dev/null 2>&1 || die "\`$CARGO\` is not on PATH, so nothing was checked. An unrun check is not a clean one."

# --- 2. what is behind, per directory -------------------------------------------------------------

body_updates=""
total=0

while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  manifest="$REPO_ROOT$dir/Cargo.toml"
  [ -f "$manifest" ] || die "declared directory $dir has no Cargo.toml - dependabot.yml and the tree disagree."

  # `--dry-run` resolves and reports without writing the lockfile. Its stderr carries the report.
  if ! out="$("$CARGO" update --dry-run --manifest-path "$manifest" 2>&1)"; then
    # A LOCAL FAILURE IS NOT THE DEPENDABOT FAILURE. `build.rs` is present in a real checkout, so
    # the `links` refusal that stops Dependabot does not happen here; anything that does is a
    # genuinely broken manifest or a network refusal, and reporting it as "no updates" would be the
    # exact defect this mechanism exists to end.
    printf '%s\n' "$out" | tail -20
    die "\`cargo update --dry-run\` failed in $dir. That is not an empty result, it is an unanswered question."
  fi

  # Cargo prints `    Updating <name> v<old> -> v<new>` for each package it would move.
  lines="$(printf '%s\n' "$out" | grep -E '^[[:space:]]*(Updating|Upgrading) ' | sed 's/^[[:space:]]*//' || true)"
  count="$(printf '%s' "$lines" | grep -c . || true)"
  total=$((total + count))

  if [ "$count" -gt 0 ]; then
    body_updates="${body_updates}
### \`${dir}\` - ${count} behind

\`\`\`
${lines}
\`\`\`
"
  fi
done <<<"$blocked"

# --- 3. the durable state: one issue, found by title ----------------------------------------------

if ! existing="$("$GH" issue list --repo "$REPO" --state open --search "$ISSUE_TITLE in:title" \
  --json number,title --jq "[.[] | select(.title == \"$ISSUE_TITLE\")] | .[0].number // empty" 2>&1)"; then
  printf '%s\n' "$existing" | tail -5
  die "could not read the issue list. A refusal is not an answer: without it this run cannot tell an open report from none."
fi

if [ "$total" -eq 0 ]; then
  if [ -n "$existing" ]; then
    "$GH" issue comment "$existing" --repo "$REPO" --body \
      "Every blocked cargo directory is now up to date; closing. This is written by \`cargo-blocked-update-report.sh\` and will reopen as a new issue when they fall behind again." >/dev/null ||
      die "the directories are up to date but the issue could not be commented, so it would have been closed silently."
    "$GH" issue close "$existing" --repo "$REPO" >/dev/null ||
      die "the directories are up to date but issue #$existing could not be closed."
    echo "ok: nothing behind; closed issue #$existing."
  else
    echo "ok: nothing behind across $(printf '%s\n' "$blocked" | grep -c .) blocked cargo directories, and no issue open."
  fi
  exit 0
fi

body="$(
  cat <<EOF
Dependabot **cannot open a pull request** for these directories: a manifest reachable from each of
them declares \`links\`, and Dependabot's temp checkout carries manifests and lockfiles but never a
\`build.rs\`, so cargo refuses them before considering any version. That is upstream in
dependabot-core and nothing here can fix it; the \`links\` key itself cannot be removed, because it
is what exposes the build script's metadata to \`tauri-build\` and therefore what makes the mobile
plugin's Kotlin compile into the app at all.

So these updates are applied **by hand**, and this issue is the trigger that says when.
$body_updates
### How to take them

\`\`\`sh
cd frontend/src-tauri && cargo update
\`\`\`

Then open an ordinary pull request. **A cargo bump here also touches the two committed lockfiles a
mobile build reads**, so let CI build the Android artefact before merging.

---

<sub>Written by \`.github/scripts/cargo-blocked-update-report.sh\`, on the weekly \`Scheduled\` run.
This issue is UPDATED rather than duplicated, and closed automatically once the directories are
level. The decision behind it, and the two options it rejected, are in \`docs/wiki/backlog.md\`.</sub>
EOF
)"

if [ -n "$existing" ]; then
  "$GH" issue edit "$existing" --repo "$REPO" --body "$body" >/dev/null ||
    die "issue #$existing exists but could not be updated, so its contents are now stale and nothing says so."
  echo "ok: $total pending update(s); refreshed issue #$existing."
else
  "$GH" issue create --repo "$REPO" --title "$ISSUE_TITLE" --body "$body" >/dev/null ||
    die "$total update(s) are pending and the issue could not be created, so nothing records them."
  echo "ok: $total pending update(s); opened the issue."
fi
