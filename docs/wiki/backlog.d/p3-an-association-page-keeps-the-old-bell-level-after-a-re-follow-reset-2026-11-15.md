## P3 - an association page keeps the old bell level on screen after a re-follow reset (found by the bell reading, Mi 9T, 2026-11-15)

target: 1.8.0

Found reading [the bell, WP-3](../engagement.md#wp-3---the-bell-built) on the Mi 9T (`1.6.12-alpha.2`, dev): with an
association's bell at "Lives seulement", "Ne plus suivre" then "Suivre" on the SAME open page. The server did its part
(`GET /api/posts/me/bells` answered `[]` right after the re-follow, a new follow resets a reduced bell), but the page kept
reading "Lives seulement" for the 5 s it was watched; leaving the page and coming back read "Publications et lives".
`AccountBell.svelte` reads its level once, on mount, and `AssociationDetailView.svelte` mounts it with the follow state
beside it, so a follow that resets the bell never reaches it. A member who re-follows and looks at the bell is told a
reduced level that no longer holds, so the next post they expect to be silent will push. The person profile did not
show it in the same sitting (its follow is a request, read again on the next visit).

Fix at the cause, not with a timer: the bell re-reads its level when the follow state it sits beside changes to
"following" (a prop the bell depends on), and a component test pins unfollow, follow and the re-read. Reading closed
the other halves of WP-3 the same sitting (see the reading's entry).
