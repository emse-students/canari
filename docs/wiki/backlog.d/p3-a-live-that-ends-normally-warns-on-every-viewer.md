## P3 - a live that ends normally makes every viewer log a warning (2026-11-17)

target: 1.7.1

**Seen on the Mi 9T, `1.7.0-alpha.9`, dev, the phone sitting of 2026-11-17**
([device-verification](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha9-both-phones-and-the-rig)):
the iPhone's broadcaster ended its live through "Terminer le live", and the Mi's viewer, which had
played it cleanly, logged

```
warning: [LIVE] viewer <live>: stopped on ended (410 ended)
log:     [LIVE] viewer <live> (ended): 116 segments played, 0 skipped, 1 seeks, at 128
```

**What is wrong.** The end of a live is the ordinary close of every viewing, yet it is written at
`warn`: `livePlayer.ts` sends every stop that is not an unexplained `unavailable` to the same
`console.warn` (`stopped on ${final.kind}`), and `replayPlayer.ts` does the same for a replay
(`[LIVE_REPLAY] ... stopped on`). Every viewer of every live adds one warning, so a reader learns to
skip the line that would also carry a real stop (the noise rule).

**The fix:** classify the stop by its kind: `ended` (the broadcaster's own end, a `410 ended`)
logs at `debug` or `log` next to the summary line, and `warn` stays for the kinds that mean
something went wrong. The kinds are already a typed `final.kind`, so this is a choice per kind, with
the matching case in the players' tests.
