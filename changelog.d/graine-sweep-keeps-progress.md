### Fixed - the Graine retention sweep keeps what its answered chunks proved and resumes

A chunk the server never answered used to abandon the whole sweep, so a phone holding 1,100 seeds on a poor link never shrank: each answered chunk now drops its expired seeds at once, and the rest resumes on the next foreground or connection ([channel-encryption](docs/wiki/protocols/channel-encryption.md)).
