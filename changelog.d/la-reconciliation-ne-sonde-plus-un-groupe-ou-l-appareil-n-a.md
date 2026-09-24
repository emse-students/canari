### Fixed - la reconciliation ne sonde plus un groupe ou l'appareil n'a pas de feuille

Mesure sur DEL-1 : quelques secondes apres qu'un pair l'a re-ajoute a un groupe dont il avait ete
evince, et avant que le Welcome soit traite, l'audit de connexion prenait ce groupe - une eviction
laisse l'etat dans le magasin WASM comme groupe INACTIF - diffusait une sonde `history_state` et
recevait `403 sender_not_active`, journalise comme un echec d'envoi. Rien n'etait perdu ; c'etait
la DEMANDE qui etait fautive, le magasin local repondant sans reseau. Le garde rejoint celui des
groupes de distribution dans `reconcileGroup`, la seule porte par laquelle passent les quatre
declencheurs. Un jet n'est pas un `false` et laisse passer la sonde
([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#two-groups-are-refused-before-anything-leaves-and-both-are-answered-locally)).
