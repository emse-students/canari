### Changed - a call's ring-end push no longer names the conversation

The push that stops a ring on every member's device now carries only the call id and the reason, so
Google and Apple no longer read which conversation a call was in
([content-free-push](docs/wiki/protocols/content-free-push.md#6-calls---the-ring-stays-immediate)).

The privacy policy and the register no longer claim a call ring carries the caller's and the
conversation's names: since decision 6 it carries ids only, and the phone names the caller itself.
