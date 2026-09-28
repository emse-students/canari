### Fixed - a community newcomer's shut phone is admitted even when their other devices join first, and reads the invitation

The admitter rebuilds its Add after losing the epoch to the newcomer's own clients, a frame waiting
on its Welcome is queued behind it on the phone, and an invitation push names the community instead
of "Nouveau message" ([channel-encryption](docs/wiki/protocols/channel-encryption.md#how-it-is-built)).
