## P2 - a parked outbox entry logs the wrong cause, and repeats it at ERROR on every start

target: 1.8.0

A frame the server REFUSED with 403 (a typed `UnsendableCause`) is later logged as "the server answered 5xx on 5 attempts in a row - parked as failed". The line also repeats at ERROR level on every app start, for every parked entry. Seen on the `1.7.3-alpha.7` Mi 9T reading of the #3969 orphan adoption; the member-visible behaviour, a failed bubble with Delete, was right.

Two fixes: (1) the parked cause carries the real `UnsendableCause`, classified at the throw and never read from a message; (2) the line is logged ONCE, when the entry is parked, never on every start (noise is never acceptable, [CLAUDE.md](../../../CLAUDE.md)). A test pins both.
