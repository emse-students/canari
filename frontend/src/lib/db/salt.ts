// ---------------------------------------------------------------------------
// Encryption salt helper — SUPPRIMÉ (Phase 3 : deviceKeyB64 remplace PBKDF2).
//
// L'ancienne fonction `getOrCreateEncryptionSalt` n'est plus nécessaire car
// le chiffrement des messages locaux n'utilise plus PBKDF2. La clé AES-256-GCM
// est dérivée une fois du PIN via Argon2id au premier login (deviceKeyB64),
// puis importée directement comme CryptoKey pour tous les messages suivants.
// ---------------------------------------------------------------------------
