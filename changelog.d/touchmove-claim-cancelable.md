### Fixed - "Ignored attempt to cancel a touchmove event" after a fling

The swipe claims a move only when it is cancelable; a refused claim ends the gesture cleanly.
