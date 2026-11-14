## P3 - A field change heard during a listing is overwritten by its older answer (2026-10-26)

target: 1.9.0

The existence half is fixed: a salon or community heard of, or removed, while a listing is in flight
is dated against it ([chat](../frontend/modules/chat.md#a-live-fact-heard-during-a-listing-is-newer-than-its-answer-2026-10-26)).
FIELDS are not: a rename or a `viewerCanWrite` change (`channel.updated`), a role change
(`workspace.role.changed`) or a cover/history change (`workspace.updated`) heard in that window is
overwritten by the listing's older row (`upsertChannelRow`, `upsertWorkspaceFromDto`) until the next
listing. Owed: whether it is seen at all (a demoted admin keeping controls for one listing is the
case that matters), then the same ledger keyed per field if it is.

**Plan (batch 13, 2026-11-11).** The existence ledger of #2509 dates a whole row; FIELDS need the same ledger keyed per (row, field): `channel.updated` (name, `viewerCanWrite`), `workspace.role.changed`, `workspace.updated` each record the field and the instant heard, and `upsertChannelRow` / `upsertWorkspaceFromDto` skip a field heard after the listing was asked. Medium, client only, testable with the existing listing-race tests; the role change (a demoted admin keeping controls) is the case that matters. Can be done in the queue without an agent.
