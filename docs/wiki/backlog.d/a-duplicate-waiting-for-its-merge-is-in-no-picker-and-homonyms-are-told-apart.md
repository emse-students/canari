## P2 - A duplicate waiting for its merge is in no person picker, and two people of the same name are told apart

target: 1.8.3

The design is D56 in [profiles-and-access](../profiles-and-access.md#the-alumni-merge-extended-d52-d58-planned-for-183)
([decisions](../decisions/owner-decisions-of-2026-11-26-alumni.md), item 6). Seen 2026-11-26: the
new-discussion picker ("Choisissez une ou plusieurs personnes") listed the real account and its
marked duplicate as two identical rows. Charter principle 7, and one rule for every picker of the
app, applied by the server that answers them all.

What it builds:

- **(a)** `UsersService.search` and `UsersService.directory` exclude a user whose `miconnectUuid` is
  the duplicate of an OPEN `alumni_merges` row (REQUESTED or MARKED), one `NOT EXISTS` beside the block
  clause; a cancelled merge brings the account back; it stays reachable from the admin merges list.
  Every picker goes through those two queries: `UserAutocomplete.svelte` and `MultiUserSelector.svelte`
  (in `SidebarNewChatModal`, `SidebarCommunityAdminPanel`, `ChannelSettingsPanel`, `EditMembersTab`,
  `EditAchatsTab`, `EditCotisationsTab`, `AccessSection`, `AdminEntityCreateForm`, `BookingSheet`,
  `ResourceEditor`, `PostActionsMenu`, `PostSearchFilters`), `useMentionAutocomplete`, and the
  directory. `GET /users/batch` is not a picker and is unchanged.
- **(b)** The search rows carry the earliest promo and formation; `distinguishHomonyms` in
  `frontend/src/lib/utils/users/` adds the promo, or the formation when the promos are equal, to every
  row whose folded name (the `normalizeName` rule) another shown row shares; both pickers and the
  mention list render it; two rows still identical log `[PICKER] homonyms with nothing to tell apart`
  at warning. The label is Paraglide (`picker_homonym_detail`).

The tests that prove it:

- `users.service.spec.ts`: search and directory leave out a REQUESTED and a MARKED duplicate, keep it
  after a cancel and never hide the target; the block clause still applies alongside.
- `distinguishHomonyms.test.ts`: no detail without a homonym; the promo for two promos; the formation
  when the promos are equal; the warning (and no bare pair) when both are equal; accents and case
  folded.
- `UserAutocomplete` and `MultiUserSelector` component tests render the detail for a homonym pair.
