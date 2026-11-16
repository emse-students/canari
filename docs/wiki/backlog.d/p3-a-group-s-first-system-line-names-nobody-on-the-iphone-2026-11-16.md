## P3 - A group's first system line names nobody on the iPhone (`1.7.0-alpha.2`, 2026-11-16)

target: 1.7.0

On the iPhone 12 (TestFlight `1.7.0-alpha.2`, dev, `gamma`), in a group that `alpha` created on a web seat and to which `beta` and `gamma` were added, the oldest system line of the conversation reads "Utilisateur inconnu a ajoute Utilisateur inconnu, Utilisateur inconnu au groupe" (the `user_unknown_label` fallback three times), while the lines under it resolve their names ("Canari Test Alpha a ajoute un appareil", the same for `gamma` and `beta`). Read from the accessibility tree and a screenshot; the group was a fixture of the web pseudos sitting.

Not established: whether it is the creation event replayed before the roster names are held (a join by Welcome, then the names arrive), or a name lookup that is never retried; whether a fresh install shows it for every group created by someone else. **What would close it:** open the same group on a second device that joined after the creation and read its first line; read `[PEER-NAMES]` in the in-app log at the open; and if the names are known by then, the line must be drawn again when they arrive. Evidence: the harness folder `iphone-next/`.
