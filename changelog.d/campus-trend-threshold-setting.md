### Changed - the campus-trend threshold is a server setting

`CAMPUS_TREND_THRESHOLD` (default 10, production's value, so production is unchanged) lets dev lower the number of distinct accounts that make a post a trend, so a four-account bench can stage the crossing; a value that is not a positive integer stops social-service at boot ([engagement](docs/wiki/engagement.md#r1---the-trend-threshold)).
