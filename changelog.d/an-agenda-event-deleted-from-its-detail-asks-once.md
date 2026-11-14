### Fixed - deleting an association's event from its detail asks for the confirmation once

The detail's Delete confirmed, then `removeEvent` confirmed again; `removeEvent` now owns the only
confirmation (`frontend/src/lib/components/associations/AssociationCalendarSection.svelte`, read on
dev 2026-11-14 in [the institution event reach entry](docs/wiki/backlog.d/institution-event-reach.md)).
