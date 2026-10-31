## P3 - A toast draws over the dev-only "Environnement de test" banner (Mi 9T, 2026-10-28)

On a dev build the `share_items_lost` toast lands on top of the test-environment banner at the top
of the screen and the two texts overlap. Production carries no such banner, so only dev and tester
builds show it; any toast placed at the top meets it the same way. Deciding: whether toasts sit
below the banner or the banner yields while a toast shows.
