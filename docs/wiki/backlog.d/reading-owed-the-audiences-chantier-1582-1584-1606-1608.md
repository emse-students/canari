## Reading owed - the audiences chantier (#1582, #1584, #1606, #1608)

target: 1.7.0

**What is built:** the audiences chantier (#1582, #1584, #1606, #1608)

**The reading that closes it:** one look at `/admin/read-access` signed in; the Audience tab of an association read by a BDE star; a global admin's phone reading of the institution creation flow; the institution creation form and the Audience tab's "Custom" grid (`CellPicker`) read on a phone with a real global-admin account (read at 390 and 1280 on the local estate with the sandbox admin only)

**Read 2026-11-14 on dev (`1.6.12-alpha.2`, two desktop Chrome profiles, test accounts):** `/admin/read-access` read signed in as a global admin: the page draws (named-reader list, log, document-reviewers tab). Still owed: the BDE star's Audience tab, the institution creation form and the Custom grid on a phone.

**Again 2026-11-14 on dev:** the BDE star's Audience tab cannot be staged with the test accounts (the only one holding a BDE right is also a global admin, and granting another is a permission the owner approves); the rule it reads is pinned by `associations/editSections.test.ts` ("gives danger to whoever may archive and the audience to a global admin or BDE star"). Read as a global admin: the Audience tab at 1280 px, the institution creation form at 390 and 1280 px with no horizontal overflow. **Left: the phone half** - the institution creation flow and the Custom grid (`CellPicker`, now on `/admin/spaces`) on a phone with a real global-admin account.
