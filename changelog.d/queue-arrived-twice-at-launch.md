### Fixed - a second pull at launch no longer lists rows the first pull's drain had not acknowledged

Two pulls ran side by side at boot, and the second listed rows the first's drain had applied but not
yet acknowledged, accused as an ack the server forgot (`[QUEUE] delivery ... arrived twice`, twice per
launch on the Mi 9T); a pull asked meanwhile is now owed and runs once, behind the drain's ack
([chat](docs/wiki/frontend/modules/chat.md#one-pull-at-a-time-and-the-one-asked-meanwhile-is-owed-2026-11-04)).
