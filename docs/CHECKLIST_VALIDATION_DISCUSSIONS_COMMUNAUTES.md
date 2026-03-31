# Checklist de Validation Manuelle (Questionnaire)

Date du test:
Testeur:
Commit testé:
Environnement (local/prod):

## 1) Multi-appareils (discussion privée)

- [ ] Scenario execute: jolan connecte sur appareil A puis appareil B
- [ ] La discussion existante apparait sur A et B
- [ ] Depuis B, un message vers test est recu par test
- [ ] Depuis B, le message apparait aussi sur A (meme conversation)
- [ ] Aucun log bloquant de type "Ignoré: pas un message pour un groupe existant" apres 30s

Resultat global:
- [ ] OK
- [ ] KO

Si KO (copier-coller exact):
- Actions realisees:
- Logs pertinents:

## 2) Groupes (Projet Alpha)

- [ ] jolan cree "Projet Alpha"
- [ ] jolan invite test et test2
- [ ] test recoit invitation + premier message
- [ ] test2 recoit invitation + premier message
- [ ] Le nom affiche est "Projet Alpha" (pas "jolan") chez test et test2
- [ ] Message groupe envoye par jolan recu par test et test2
- [ ] Renommage groupe propage chez tous les membres

Resultat global:
- [ ] OK
- [ ] KO

Si KO (copier-coller exact):
- A quel membre/appareil ca casse:
- Logs pertinents:

## 3) Communautes

- [ ] Creation d'une communaute (workspace) fonctionne : `POST /api/channels/workspaces`
- [ ] Aucun 500 a la creation
- [ ] Message UI de succes affiche
- [ ] Creation d'un canal public dans la communaute fonctionne
- [ ] Le canal apparait dans la sidebar sans refresh
- [ ] Invitation d'un membre par un admin fonctionne : `POST /api/channels/:id/members/invite` (body: actorUserId + targetUserId)
- [ ] L'invite recoit un evenement temps-reel `channel.member.joined` via WebSocket
- [ ] Expulsion d'un membre fonctionne : `POST /api/channels/:id/members/kick`
- [ ] Le membre expulse recoit un evenement temps-reel `channel.member.kicked` via WebSocket
- [ ] Envoi d'un message dans le canal : `POST /api/channels/:id/messages` (body: ciphertext + nonce + keyVersion + senderId)
- [ ] L'evenement `channel.message.created` est bien recu par les membres connectes via WebSocket

Resultat global:
- [ ] OK
- [ ] KO

Si KO (copier-coller exact):
- Requete en echec (endpoint + code HTTP):
- Message UI:
- Logs backend:

## 4) Resume final

- [ ] Tout passe
- [ ] Encore des KO

Priorite des KO restants (P1/P2/P3):
1.
2.
3.

Bloc le plus critique a corriger en premier:
