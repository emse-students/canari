# Roadmap Synchronisation QR Multi-Appareils

## Objectif

Mettre en place une synchronisation bidirectionnelle des historiques entre deux appareils d'un meme utilisateur, via QR code, sans modifier ni contourner le protocole MLS.

## Contraintes de securite

- Le QR transporte uniquement un rendez-vous ephemere (session + jeton), jamais des messages.
- Les donnees synchronisees restent chiffrees (rows deja chiffrees par PIN cote client).
- Session one-shot avec expiration courte (TTL) et verification du meme userId.
- Compatibilite MLS: la sync complete l'historique local, mais ne remplace pas les commits/welcomes MLS.

## Plan d'implementation

### Phase 1 (terminee)

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

### Phase 2 (terminee)

- Canal de transfert via endpoints de session (stockage ephemere Redis).
- Echange des chunks manquants dans les deux sens.
- ACK one-shot sur pull (suppression du payload apres lecture).
- Import non destructif sur chaque appareil (`mergeConversation` + `importEncryptedRow`).
- Endpoints ajoutes:
  - `POST /mls-api/sync/session/chunks/upload`
  - `GET /mls-api/sync/session/:sessionId/chunks/pull`

### Phase 3 (en place, version MVP)

- UI complete:
  - Actions "Demarrer" / "Joindre" dans la sidebar
  - Affichage payload QR cote initiateur
  - Colle du payload cote second appareil (remplace temporairement le scan camera)
  - Progression et resume final dans une modal dediee
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
