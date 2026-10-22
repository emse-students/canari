### Fixed - a live salon frame without a ciphertext is refused, never rendered

A salon message's author is proven only by opening it, so a frame with no ciphertext is refused at error level rather than shown under the author it names ([backlog](docs/wiki/backlog.md#the-harness-itself)).
