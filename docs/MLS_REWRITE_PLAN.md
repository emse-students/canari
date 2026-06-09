# Plan : Réécriture MLS Canari

> Démarré : 2026-06-03. Durée cible : 2 jours.
> Philosophie : RFC 9420 + OpenMLS book fork-resolution. Simplicité max, zéro pansements.

## Invariants non-négociables

1. `getLocalGroups()` est la seule source de vérité pour l'état de groupe.
2. Tout message est ACKé exactement une fois.
3. Aucun état machine en mémoire (pas de Sets/Maps de recovery).
4. Un seul chemin de recovery, deux étapes : `welcome_request` (30s) → `reboot`.
5. Le successeur est atomique (CAS). Inchangé.

## Ce qu'on supprime

| Supprimé                                                      | Remplacé par                            |
| ------------------------------------------------------------- | --------------------------------------- |
| `reinvite_request`                                            | Supprimé - Reboot couvre le cas         |
| États `stale`, `welcome_received`                             | `pending / active / removed` uniquement |
| `triggerEpochRecovery()`                                      | `requestReAdd()` (1 ligne)              |
| `poisonPill()`                                                | Reboot (toujours récupérable)           |
| Comptage null (phantom detection)                             | 1 échec → requestReAdd directement      |
| `epochRecoveryGroups`, `recoveryInProgress`, `poisonedGroups` | Supprimés                               |
| Bloc1/Bloc2 dans connection                                   | 1 passe unique avec `seen` Set          |
| 8s deferred flush pour tous                                   | commits=immédiat, app=2s                |
| `lastKnownState` périmé dans worker                           | État frais à chaque génération          |
| `deleteAllPrekeys` avant génération                           | Générer d'abord, supprimer ensuite      |
| Buffer 20 msgs / 90s → Poison Pill                            | Buffer 10s → ACK + requestReAdd         |
| Double welcome_request Bloc1+Bloc2                            | Set `seen` dans passe unique            |

## Ce qu'on garde

- Successeur / CAS (`claimGroupSuccessor`) - c'est la bonne approche MLS Reboot
- Tab leadership (Web Locks + fallback)
- `MlsPerGroupScheduler` (round-robin sous mutex)
- `mlsDeliveryApi.ts` (thin wrapper) sauf suppression `reinviteRequest`
- `WebMlsService` / `TauriMlsService` (structure, méthodes simplifiées)
- Format des conversations et stockage IndexedDB/SQLite

## Nouveaux fichiers cible

```
frontend/src/lib/mls-client/
├── IMlsService.ts          # Simplifié (states: pending|active|removed)
├── pipeline/
│   ├── pipeline.ts         # Message handler ~250L (vs 1064L actuel)
│   └── deps.ts             # Dépendances injectées
├── recovery.ts             # requestReAdd() + reboot() uniquement
├── connection.ts           # syncAfterConnect() - passe unique
├── keyPackages.ts          # replenishKeyPackages() - fix S2+C5
└── index.ts                # Re-exports publics
```

## Phases d'implémentation

### Phase 1 - Types (Jour 1 matin)

- `MembershipStatus = 'pending' | 'active' | 'removed'`
- `ProcessResult` typé (plus de `null` ambigu)
- Supprimer `stale`, `welcome_received` de `IMlsService.ts`

### Phase 2 - Pipeline (Jour 1 après-midi)

- `handleWelcome()` : processWelcome → active/noop/welcome_request
- `handleUnknownGroup()` : buffer 10s → welcome_request → ACK
- `handleKnownGroup()` : decrypt → ok/duplicate/own/out_of_sync → requestReAdd
- ACK policy : toujours ACK après traitement

### Phase 3 - Recovery (Jour 1 soir)

- `requestReAdd(groupId, deps, timers)` : welcome_request + timer 30s → reboot
- `reboot(groupId, deps)` : CAS + inviteMembers + migrateConversation
- `inviteMembers()` : addMembersBulk + sendCommit AVANT sendWelcome + retry add-lock
- `migrateConversation()` : dédup (check `conversations.has(to)`)

### Phase 4 - Connection (Jour 2 matin)

- `syncAfterConnect()` : une passe, Set `seen`, pas de Bloc1/Bloc2
- Suivre successeurs automatiquement
- `processDeviceInvitations()` : relancé via `onGroupReady`

### Phase 5 - KeyPackages (Jour 2 matin)

- TARGET=20 OTKPs, seuil=5
- Génération D'ABORD, upload, persist, suppression
- Rotation fallback à chaque replenish

### Phase 6 - Persistence (Jour 2 matin)

- commits → `persistNow()`
- app messages → `scheduleDeferred(2_000)` (was 8s)
- visibilitychange → flush

### Phase 7 - Backend (Jour 2 après-midi)

- `chat-delivery-service` : supprimer endpoint `POST /api/mls/reinvite-request`
- Migration SQL : `stale → pending`, `welcome_received → active`
- Supprimer colonnes `stale`/`welcome_received` de `DeviceGroupMembership`
- Supprimer logique Redis `pending_reinvite:*`

### Phase 8 - Audit fixes (Jour 2 après-midi)

Adresser : S2 (fallback rotation), S3 (PIN change), S5 (worker state),
C4 (orphan cleanup), R4 (epoch avant addMembersBulk), R5 (add-lock retry)

### Phase 9 - Tests (Jour 2 soir)

- `pipeline.test.ts` : 7 cas
- `recovery.test.ts` : 7 cas
- `connection.test.ts` : 4 cas
- `keyPackages.test.ts` : 4 cas

## Bugs corrigés par la réécriture

| Bug                           | Correction                         |
| ----------------------------- | ---------------------------------- |
| S2 fallback statique          | Rotation dans replenishKeyPackages |
| S5 lastKnownState périmé      | État frais passé au worker         |
| C1 null ambigu                | ProcessResult typé                 |
| C2 faux positif null counting | Supprimé                           |
| C3 Poison Pill transient      | Supprimé                           |
| C4 orphan group CAS           | Retry cleanup dans catch           |
| C5 deleteAll avant generate   | Ordre inversé                      |
| C7 buffer drop silencieux     | Buffer 10s + ACK explicite         |
| C8 migrate sans dédup         | Check `conversations.has(to)`      |
| R1 watchdog vs Welcome        | Timer annulé dès WASM ok           |
| R2 coalescence insuffisante   | `timers.has(groupId)` gate         |
| R3 double welcome_request     | Set `seen` passe unique            |
| R4 addMembersBulk sans epoch  | sendCommit via path validé         |
| R5 add-lock silencieux        | Retry 2s                           |

## Références

- RFC 9420 : https://www.rfc-editor.org/rfc/rfc9420
- OpenMLS fork resolution : https://book.openmls.tech/user_manual/fork-resolution.html
- OpenMLS add members : https://book.openmls.tech/user_manual/add_members.html
