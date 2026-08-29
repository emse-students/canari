# Play vitals watch

Reads Android vitals, crash clusters and track state straight from Google Play, because **no gate in
this repository can see any of them**. Every Android check here proves the app compiles and that R8
did not crash; none runs the app on a stranger's phone. All three Android defects found so far were
found there.

```
node vitals.mjs            # the report
node vitals.mjs --stacks   # plus one stack trace per issue that is not already known
node vitals.mjs --json     # plus the raw payloads, for diffing two runs
```

Exit code `0` nothing new, `1` a NEW or REGRESSED issue is present, `2` the run itself failed.

## The credential

A Google Cloud service account, `canari-dev@canari-496310.iam.gserviceaccount.com`, invited into the
Play Console. **Canari is a public repository, so the key is never stored in it.** It lives beside
the harness state at `../../../canari-harness/play-console-sa.json`, which `git clean -xdf` cannot
reach and where nothing can be committed by accident. `PLAY_SA_KEY` overrides the path.

Two enablements were needed once, and neither is re-doable by this tool: the
**Play Developer Reporting API** turned on in project `canari-496310`, and the service account
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
few installs for a rate.

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
