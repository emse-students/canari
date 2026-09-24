### Fixed - une creation de discussion refusee le dit, au lieu de fermer la fenetre

`createNewGroup` et `startNewConversation` rendaient `void` : un nom deja pris, un blocage, un
service de blocage injoignable, un contact jamais connecte et toute exception finissaient dans une
ligne de log, la fenetre se fermait sur une conversation inexistante et rien ne disait pourquoi.
Les deux chemins rendent desormais un motif TYPE, la fenetre reste ouverte, garde le texte saisi et
affiche la phrase correspondante.
[chat](docs/wiki/frontend/modules/chat.md#a-creation-that-is-refused-now-says-which-refusal-it-was-2026-09-24)
