# Roadmap Synchronisation QR Multi-Appareils

## Objectif
Mettre en place une synchronisation bidirectionnelle des historiques entre deux appareils d'un meme utilisateur, via QR code, sans modifier ni contourner le protocole MLS.

## Contraintes de securite
- Le QR transporte uniquement un rendez-vous ephemere (session + jeton), jamais des messages.
- Les donnees synchronisees restent chiffrees (rows deja chiffrees par PIN cote client).
- Session one-shot avec expiration courte (TTL) et verification du meme userId.
- Compatibilite MLS: la sync complete l'historique local, mais ne remplace pas les commits/welcomes MLS.

## Plan d'implementation

### Phase 1 (lancee dans ce commit)
- Endpoint backend pour creer une session QR:
  - `POST /mls-api/sync/session/start`
- Endpoint backend pour rejoindre une session:
  - `POST /mls-api/sync/session/join`
- Endpoint backend pour deposer un manifeste local:
  - `POST /mls-api/sync/session/manifest`
- Endpoint backend pour calculer les manques bidirectionnels:
  - `POST /mls-api/sync/session/diff`
- Endpoint backend pour lire l'etat de session:
  - `GET /mls-api/sync/session/:sessionId?userId=...`
- Moteur frontend:
  - Construction du manifeste local depuis `IStorage`
  - Calcul de diff local/remote
  - Construction des chunks de transfert sur base des rows chiffrees
  - Client API pour start/join/manifest/diff

### Phase 2 (prochaine etape)
- Canal de transfert chiffre applicatif appareil<->appareil (relay websocket ou polling court).
- Echange des chunks manquants dans les deux sens.
- ACK de chunks + reprise sur erreur.
- Import non destructif sur chaque appareil (`mergeConversation` + `importEncryptedRow`).

### Phase 3
- UI complete:
  - Ecran "Synchroniser un appareil"
  - Affichage QR cote initiateur
  - Scanner QR cote second appareil
  - Progression et resume final
- Verification croisee finale (hash par conversation).

### Phase 4
- Durcissement securite:
  - Code de verification 6 chiffres affiche sur les deux appareils
  - Rate limit par user/session
  - Nettoyage automatique des sessions/manifestes
  - Telemetrie minimale (taux de succes, temps moyen)

## Regles de fusion des donnees
- Identifiant canonique de message: `message.id`
- Si meme `message.id` present des deux cotes:
  - `isDeleted`: tombstone gagnante
  - `isEdited`: version la plus recente
  - `readBy`: union
  - `reactions`: union `(userId, emoji)`
- Conversations:
  - metadata merge non destructif
  - membership reste sourcee par MLS/serveur de groupe

## Validation attendue
- Check/lint/tests frontend passent.
- Build backend NestJS passe.
- Scenario de test manuel:
  1. PC demarre session QR
  2. Mobile rejoint
  3. Les deux upload manifest
  4. Diff bidirectionnel coherent
  5. Import des rows manquantes sans ecraser l'existant
