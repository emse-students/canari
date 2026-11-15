## P2 - a BDE, a parent super-admin and the platform admin rewrite another body's event or form

target: 1.9.0

**Owner, 2026-11-15** ([moderation-authority](../moderation-authority.md), decision 8): a BDE
validates, rejects or deletes an event, but never rewrites another body's event text. The same rule
for forms, which the platform admin and the parent BDE's super-admin edit today.

**Today.**

- Events: `assertMayWriteEvent` (`apps/social-service/src/associations/associations.service.ts`) lets
  through a global admin, a validator (`mayValidateEvent`, the BDE of a TARGETED space) and anyone
  passing `mayAct(PROPOSE_EVENT)` - a parent super-admin included - and the same gate guards `PATCH`
  and `DELETE /associations/:id/events/:eventId`. The post-integrity rule (403
  `POST_EDIT_PUBLISHER_ONLY`) does not hold for the event that post announces.
- Forms: `managesForm` (`forms/form-ownership.ts`) answers true for a global admin and for
  `mayAct(MANAGE_FORMS)`, which a parent super-admin passes (`MANAGE_FORMS` is not in
  `SUPER_ADMIN_EXCLUDED_FLAGS`); it gates editing and deleting alike.

**The change.** Split the write gate in two, as posts already are (`canEdit` beside `canManage`):

- **rewrite** (text, date, place, questions): the organiser's own `PROPOSE_EVENT` or `MANAGE_FORMS`
  holders, an accepted co-organiser on its side (text and poster, unchanged), a personal form's owner -
  read through the member's own flags, NOT `mayAct`, so neither the super-admin tier nor the global
  admin passes. A refused rewrite is a typed 403 of its own for events and for forms.
- **regulate** (validate, reject, delete; close or delete a form): unchanged - the validator, the
  parent super-admin, and the platform admin as recourse.

**The super-admin, decided by the owner on 2026-11-15** (decision 12, *"Non, l'acte visible
suffit"*): a parent super-admin holds `MANAGE_ASSO`, so it can make itself a member with
`PROPOSE_EVENT` or `MANAGE_FORMS` and rewrite. That is a visible act (it shows in the member list),
good conduct is trusted, and no further wall is built. **The platform admin's rewrite** is refused too
- the lead's reading of decision 8, which names the BDE (the platform admin edits no other text, a post
or a comment), reversible; a personal form's rewrite by the platform admin is refused under the same
rule.

**Proof.** The agenda and forms integration specs: a validator and a parent super-admin validate,
reject and delete, and get the typed 403 on a `PATCH` of another body's event; the same for a form's
questions; the organiser, the `MANAGE_FORMS` holder and the personal owner still edit. The client draws
the pencil from a served capability apart from the bin. The `[AGENDA]` rows of the
[grid spec](the-moderation-authority-grid-is-asserted-by-table-driven-specs.md).
