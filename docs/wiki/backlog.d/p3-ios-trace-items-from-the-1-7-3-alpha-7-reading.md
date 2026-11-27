## P3 - two iOS trace items from the `1.7.3-alpha.7` iPhone reading

target: 1.8.3

- Three "Raised" log lines for two sends: find which line is the duplicate and whether a banner was posted twice.
- A first-seen group while the app is suspended gets the generic fallback banner: say whether a name could be known at that point, and if not, that the generic text is the decided one.
