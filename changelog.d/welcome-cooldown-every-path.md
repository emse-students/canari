### Fixed - a device asking for a Welcome seconds after a group's creation is no longer kicked and re-added

The post-Welcome cooldown now knows every Welcome this tab sent - creation fan-out, pending invitation and Graine admission included - so the in-flight Welcome and the repair no longer overlap ([chat](docs/wiki/frontend/modules/chat.md#the-post-welcome-cooldown-knows-every-welcome-this-tab-sent-not-only-its-own-2026-10-04)).
