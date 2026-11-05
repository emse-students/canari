### Fixed - the app no longer sits on its splash from launch when the network hangs

A first launch used to wait for the silent session refresh (up to about 40 s on a path that hangs) before drawing anything. The refresh now runs beside the page: a boot screen shows at once, and a network that cannot be reached is stated, with a retry, instead of being read as a signed-out user. The cause and the table of outcomes are in [offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#first-paint-never-waits-on-the-network-the-boot-session-question-2026-11-05).
