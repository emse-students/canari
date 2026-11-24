### Fixed - the iOS "main page shifted" warning no longer fires on plain scrolling, and a page crash names where it threw

The witness of a shifted main page accuses only a box whose own CSS refuses scrolling, never the page scroller a reader scrolls ([keyboard](docs/wiki/frontend/keyboard-and-send-motion.md)); the `[App] page crash` line now carries the first frames of the stack, so the next crash says where it threw.
