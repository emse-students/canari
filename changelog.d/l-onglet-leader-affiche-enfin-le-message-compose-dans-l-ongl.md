### Fixed - l'onglet leader affiche enfin le message compose dans l'onglet suiveur

TAB-4b : avec deux onglets d'un meme compte, un message envoye depuis le SECOND s'y affichait,
atteignait le pair, et n'apparaissait pas dans le premier. Jamais une perte - la ligne est dans
l'outbox IndexedDB que les deux onglets partagent, un rechargement la montrait - mais
`canari-tab-messages` ne portait les mises a jour que du leader vers les suiveurs, et un suiveur
est pourtant seul a savoir ce qu'il vient de composer. Un evenement `own_message_composed` porte
cette seule exception : publie par un suiveur, pris avant meme que le recepteur lise son role,
dedoublonne sur l'id, et sans `unreadCount` - un message a soi n'est jamais non lu
([chat](docs/wiki/frontend/modules/chat.md#only-the-leader-tab-flushes)).
