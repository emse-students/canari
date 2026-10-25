### Fixed - a tab kill quit the whole browser

Closing a window's last tab quits Chrome, so the KILL rows' tab kill took the browser with it and the revival found no port; a blank tab now keeps the browser alive and the revival closes it, then waits for the revived sidebar to list the group before opening it ([README](tools/cross-client-harness/README.md)).
