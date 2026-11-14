## Reading owed - a tab open across a deploy offers a reload instead of "Erreur"

target: 1.7.0

**What is built:** a tab open across a deploy offers a reload instead of "Erreur" (#1278, in `v1.1.2`)

**The reading that closes it:** a tab left open across the next deploy shows the reload offer on its next lazy import, and no `Failed to fetch dynamically imported module` reaches a user
