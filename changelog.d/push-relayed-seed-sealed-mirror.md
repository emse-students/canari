### Fixed - a relayed Graine seed reaches the sealed native mirror again

The native push path read the mirror as plain text to decide whether a relayed seed's salon was already read, which failed once the mirror was sealed, so no relayed seed was mirrored. It now opens the mirror with its key; see [channel-encryption](docs/wiki/protocols/channel-encryption.md).
