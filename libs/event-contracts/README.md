# Event Contracts & Shared Schemas (JSON)

Ce module contient la définition des structures de données partagées sous forme de **JSON Schemas**.

## Pourquoi JSON Schema ?

1.  **Standard** : Les messages Kafka seront des chaînes JSON standard.
2.  **Validation** : Permet de valider la structure des messages à l'exécution ou dans les tests.
3.  **Documentation** : Sert de documentation vivante pour les champs requis, les types, etc.

## Structure

```
schemas/
  ├── domain/         # Entités métiers
  │   └── user/
  │       └── v1/
  │           └── user.json
  └── events/         # Événements
```

## Utilisation et Cohérence

Pour garantir la cohérence entre les services (Rust, NestJS), vous avez deux approches :

### 1. Génération de Code (Recommandé)

Utilisez des outils pour générer vos classes/types à partir de ces schémas JSON.


*   **TypeScript** : Utiliser `json-schema-to-typescript`.
*   **Rust** : Utiliser `typify` ou `serde_json`.

### 2. Validation Runtime

Les services peuvent charger ces schémas au démarrage et valider les messages entrants avant de les traiter.
