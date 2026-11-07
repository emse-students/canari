### Fixed - a gallery known to be down is asked by one request at a time, not by every avatar

During the five-hour gallery outage of 2026-11-05 every avatar request asked it again and logged again (2 000 `502`s an hour). core-service now remembers the outage, sends one probe, answers the rest without asking, and logs two lines: down, and back. See [upstream-reachability](docs/wiki/infrastructure/upstream-reachability.md#the-app-does-not-keep-asking-a-gallery-known-to-be-down-2026-11-07).
