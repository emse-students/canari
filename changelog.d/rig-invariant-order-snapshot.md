### Fixed - invariant 3 compared message positions read from two different lists

The positions of the post-event messages were read one marker at a time, across a redraw of the list; they are now read in one snapshot once every marker has arrived, and an out-of-order failure names the rows ([README](tools/cross-client-harness/README.md)).
