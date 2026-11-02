### Fixed - read state now reaches every device and tab without a reload

An Android app resumed on an open conversation marks it read again, a follower browser tab receives the read state and salon counts its leader received, a read in one tab moves the other tab's watermark with its badge, and a salon left selected but unread takes the server's count on reconnect ([chat](docs/wiki/frontend/modules/chat.md#read-state-between-devices---the-census-2026-11-02)).
