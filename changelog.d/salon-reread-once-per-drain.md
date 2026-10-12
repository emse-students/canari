### Changed - a salon is re-read once per drain, not once per seed it brought

Coming back online, 26 new seeds for 3 salons re-read those salons 26 times (52 requests); the
re-read now waits for the drain to end and happens once per salon
([channel-encryption](docs/wiki/protocols/channel-encryption.md#wp-33-and-the-answerer-nobody-elects)).
