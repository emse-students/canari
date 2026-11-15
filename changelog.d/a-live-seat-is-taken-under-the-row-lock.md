### Fixed - a live's seat is no longer taken after its end freed them

A viewer's access check and its seat are now one transaction under the live's row lock, so an end, a cut or a removal waits for the seats being taken and none follows it ([lives](docs/wiki/services/lives.md#a-seat-is-taken-under-the-rows-lock-2026-11-15)).
