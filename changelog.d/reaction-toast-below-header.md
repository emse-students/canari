### Fixed - a failed reaction no longer hides under the header, names a lost connection, and takes its pill back

The phone toast sits below the conversation header, a transport failure on a send is a typed `DeliveryUnreachableError` (the network sentence, not "cela n'a pas abouti"), and a reaction that was never sent is unflipped locally. See [chat](docs/wiki/frontend/modules/chat.md#a-failed-reaction-said-cela-na-pas-abouti-and-named-nothing-and-its-toast-covered-the-bubble-2026-10-06).
