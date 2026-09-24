### Fixed - le menu @ ne se propose plus vous-meme, un controle qui n'atteignait rien

Se mentionner soi-meme inserait une puce, posait son propre id sur le fil, et s'arretait la :
`notifyChannelRecipients` ecarte l'expediteur avant tout niveau de notification, le bloc de
notification d'un commentaire amorce `alreadyNotified` avec l'auteur, et `mentionsMe` ne tourne que
sur une trame ENTRANTE - qu'un message a soi n'est jamais. Et il n'existe aucune boite a mentions
ou le retrouver, ce qui retire le seul argument pour le garder. L'exclusion est dans
`useMentionAutocomplete`, pas dans ses trois appelants ; au passage elle supprime une copie de
`filterUserSuggestions` et epingle le piege dessous - une liste d'autorisation VIDE veut dire
"aucune restriction" ici et "personne" la-bas
([chat](docs/wiki/frontend/modules/chat.md#the-mention-picker-does-not-offer-you-yourself-and-that-follows-from-a-fact-2026-09-24)).
