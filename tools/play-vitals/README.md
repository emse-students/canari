# Play vitals watch

Reads Android vitals, crash clusters and track state straight from Google Play, because **no gate in
this repository can see any of them**. Every Android check here proves the app compiles and that R8
did not crash; none runs the app on a stranger's phone. All three Android defects found so far were
found there.

```
bun vitals.mjs            # the report
bun vitals.mjs --stacks   # plus one stack trace per issue that is not already known
bun vitals.mjs --json     # plus the raw payloads, for diffing two runs
```

Exit code `0` nothing new, `1` a NEW or REGRESSED issue is present, `2` the run itself failed.

## The credential

A dedicated Google Cloud service account, invited into the Play Console. **Canari is a public repository, so the key is never stored in it.** It lives in a directory outside the work tree, which `git clean -xdf` cannot reach and where
nothing can be committed by accident. `PLAY_SA_KEY` takes precedence; otherwise the key is
`play-console-sa.json` in the harness state directory, the same one `tools/cross-client-harness/names.mjs`
exports as `STATE_DIR`. There is no other fallback: a missing key fails with a message naming both
the override and the default path.

Two enablements were needed once, and neither is re-doable by this tool: the
**Play Developer Reporting API** turned on in the Google Cloud project, and the service account
granted `serviceusage.services.enable` to do it. The account cannot enable APIs on its own.

## What it reads, and what the numbers mean

| Source | Answers |
| --- | --- |
| `errorIssues:search` | the crash and ANR clusters, with first/last versionCode and API level |
| `errorReports:search` | the stack traces, one report at a time |
| `anomalies.list` | what Play itself flagged as out of the ordinary |
| nine `*MetricSet:query` | crash, ANR, error count, wakeups, stuck wakelocks, slow start, LMK, and the two memory measures |
| `edits/{id}/tracks` | what each track is actually serving |

**An empty metric set is not the same as a healthy one.** Play withholds a rate when too few users
back it, and the API expresses both as zero rows. The report says so rather than printing a green
zero. As of 2026-08-29 every rate is empty and only the error clusters carry data - this app has too
few installs for a rate. **So re-reading the rates before late September 2026 answers nothing** -
what would fill them is installs, not time, and nothing in this repository moves that number. The
error clusters are worth reading whenever a release ships; the rates are not.

**`anonRssAndSwapMemoryUsageMetricSet` and `bitmapMemoryUsageMetricSet` are the two measures Play
ENFORCES from Feb 2027**, and both are readable here, at P50 through P99, with an `appState`
dimension - which is how the thresholds are phrased. `mobile.md` listed the first as "unmeasured";
it is now merely *empty*, pending users.

## Two hard edges the API has

Both cost a 400 before they were understood, and both are handled in `lib.mjs`:

1. **Every query must be clamped to that metric set's own freshness**, which differs per set - error
   counts run days ahead of crash rates. One day past it is a hard 400, not an empty result.
2. **The metric sets take a `google.type.Date` and reject an `hours` field under DAILY. The two
   `:search` endpoints take full DateTimes and reject a NAMED time zone** (`America/Los_Angeles` ->
   "Unsupported timezone"). Leaving the zone unset means UTC, which they accept.

The legal metric and dimension names per set were not guessed: sending a deliberately bogus metric
makes the API enumerate every combination it accepts. That is cheaper than one 400 per guess.

## Archiving is not something this tool can do

**The Reporting API is read-only by construction** - its v1beta1 discovery document defines no
archive, mute or resolve method, and every `POST` it offers is a `:query`. No IAM role changes that;
IAM grants permission to call methods that exist. Archiving a crash cluster exists only in the Play
Console UI, and it hides the issue *there* while the API keeps returning it.

So the acknowledgement lives in `known-issues.json`, in the repo, beside the reasoning - and it is
deliberately **not** a mute list. Each entry names the commit that fixed the defect and the first
versionCode carrying it; an issue reappearing at or above that code is reported as a `REGRESSION`,
not swallowed. Muting by issue id alone would silence exactly the report worth waking up for.

## Platform issues

**Some crashes are not ours, and the API cannot archive them either.** A defect inside Android or
the WebView, with no Canari, wry or Tauri frame, cannot be fixed by a commit here, so it has no
`fixedBy` and no `fixedInVersionCode` - and listing it as `NEW` forever teaches the reader to skip
`NEW`. A `"kind": "PLATFORM"` record in `known-issues.json` says "not ours" and **names the evidence
that made it so**, which `classify.mjs` (`judgePlatform`) re-checks on every run against the
issue's reports, its report count per versionCode (`errorCountMetricSet` by `issueId` and
`versionCode`) and Play's user count per versionCode (`crashRateMetricSet`). It is printed as
`[PLATFORM]` and does not fail the run while all three facts hold; **one broken fact re-opens it as
`NEW`, with the reason, and the run fails**:

1. **A report carries an app frame** - a `#NN pc` or `at` line naming `fr.emse.canari` (every
   native frame from the APK does, by its path), `wry`, `tao::`, `tauri` or `mines_app_lib`. The
   report HEADER names the package too and is not a frame.
2. **A report names a WebView major newer than `webViewMajors`.** A native crash's report carries no
   WebView version and the API has no field for one, so an empty set is the honest record - and the
   first report that does name one re-opens the issue.
3. **A versionCode newer than `baseline.versionCode` reports it above `baseline.per1kUsers`**,
   reports per 1,000 distinct users of that versionCode. The Reporting API has no session count, so
   the denominator is users, not sessions. While Play withholds the user count (too few users, the
   state of every rate here as of 2026-11), **any report on a newer versionCode re-opens it**: a rate
   that cannot be measured is never read as a low one.

The record also keeps the frame list it was judged on, the affected API levels and devices, and who
decided it. `classify.test.mjs` proves each re-open rule and the control on fixtures, and that the
recorded frames carry no app frame. **The kind was decided 2026-11-03 (#2974) and is reversible**:
deleting the record makes the issue `NEW` again, which is the whole of the undo.

The first record is `7bea93777c2eb50d5aa34cb55a62350f`: a SIGABRT in `libaaudio_internal`
(`MyPlayerBase::playerTrackPause` on a destroyed mutex, on a binder thread), one report on
`100100199` (v1.1.1), a Xiaomi 14T on API 36. At v1.1.1 the app opened no audio stream itself - calls
shipped in v1.5.0 - so the only AAudio client in the process was the WebView.
