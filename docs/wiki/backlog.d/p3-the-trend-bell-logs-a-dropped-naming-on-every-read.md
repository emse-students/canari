## P3 - the trend bell logs "naming(s) no longer hold" at every read of the bell

target: 1.7.0

`PostNotificationsService.resolveTrendLikedBy` writes `[TREND] bell: N of N naming(s) no longer hold, not shown` at DEBUG each time a bell page holds a trend row whose named liker no longer qualifies (the like removed, the share switch off, an unfollow). Read on dev's social-service on 2026-11-17: the same line repeats every few seconds to every thirty seconds for hours (about 37 in 15 minutes) with no trend crossing between them - the visible end of ONE stale row polled by a client, not of anything new. Noise is never acceptable: it is either necessary or it points upstream. Fix at the source: the drop is expected and already served correctly, so the line belongs at most once per row (or not at all), not once per read. Test: a bell read of a page holding one dropped naming logs nothing the second time. See [engagement](../engagement.md).
