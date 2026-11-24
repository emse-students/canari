### Fixed - a catch-up lands in the open conversation in one render, and says it is running

Push-preview upgrades and messages from this account's other device now wait for the drain's flush
like any other arrival, instead of a render and two store round trips each (about half of a resume's
ten-second catch-up on Android); the "receiving pending messages" banner shows whenever the buffer
holds enough, and each drain logs its frame count and total time once. A buffered message leaves the buffer only for a store, written where its thread lives at the close
(a reset during group creation, or a Welcome re-keying the conversation mid-window, used to drop the
window's rows, which were then acknowledged), other tabs receive the upgraded rows, and a catch-up ending with a message from the
other device no longer pulls a reader who had scrolled up
([chat](docs/wiki/frontend/modules/chat.md#a-catch-up-lands-in-one-render-2026-11-24)).
