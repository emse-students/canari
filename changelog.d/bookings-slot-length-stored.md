### Added - a fixed-slot bookings space stores its slot length

A `slots` space now keeps the slot length chosen in the wizard or the settings (migration 116), and
the availability painter opens slots of it even on an emptied week; older spaces keep reading it
from their lines
([bookings-chantier](docs/wiki/bookings-chantier.md#painting-a-fixed-slot-space-decided-by-the-owner-on-2026-10-29)).
