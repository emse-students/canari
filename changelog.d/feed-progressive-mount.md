### Fixed - the swipe back to the feed starts at once on a slow phone

The feed mounts 3 cards, then 2 per frame, instead of 20 inside the view-transition callback (worst long frame 347-470 ms down to 143-221 ms on the Mi 9T).
