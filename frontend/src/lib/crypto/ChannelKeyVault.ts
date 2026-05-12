/**
 * An AES-GCM key tied to a specific channel epoch.
 * Channel keys are rotated when new members join so older epochs remain readable
 * for decrypting historical messages but cannot be used for new ones.
 */
export interface SymmetricPayloadKey {
  /** The epoch counter this key belongs to; increments on every key rotation. */
  epochId: number;
  /** The non-extractable AES-GCM 256-bit CryptoKey derived from HKDF material. */
  key: CryptoKey;
  /** Unix timestamp (ms) when the key was imported; useful for debugging stale keys. */
  createdAt: number;
}

/**
 * In-memory store for all AES-GCM keys of a single channel, indexed by epoch.
 *
 * Keeps all past epoch keys so that messages encrypted in previous epochs can
 * still be decrypted (e.g. when loading history). New messages are always
 * encrypted with the current (highest) epoch key.
 */
export class ChannelKeyVault {
  private keys: Map<number, SymmetricPayloadKey> = new Map();
  private currentEpoch: number = 0;

  /**
   * Imports a new 32-byte key for `newEpochId` and advances the current epoch
   * if this is the highest epoch seen so far.
   *
   * @throws If `newEpochId` is not a non-negative integer or `rawKeyMaterial` is not exactly 32 bytes.
   */
  async rotateKey(newEpochId: number, rawKeyMaterial: Uint8Array) {
    if (!Number.isInteger(newEpochId) || newEpochId < 0) {
      throw new Error(`Invalid epoch ID: ${newEpochId}`);
    }
    if (!rawKeyMaterial || rawKeyMaterial.length !== 32) {
      throw new Error(
        `Key material must be exactly 32 bytes, got ${rawKeyMaterial?.length ?? 'null'}`
      );
    }

    const key = await crypto.subtle.importKey(
      'raw',
      rawKeyMaterial as unknown as BufferSource,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    this.keys.set(newEpochId, { epochId: newEpochId, key, createdAt: Date.now() });

    // Ensure we only update to a newer epoch
    if (newEpochId > this.currentEpoch) {
      this.currentEpoch = newEpochId;
    }
  }

  /**
   * Returns the key for the current (highest) epoch.
   * @throws If no key has been loaded yet.
   */
  getCurrentKey(): SymmetricPayloadKey {
    const key = this.keys.get(this.currentEpoch);
    if (!key) {
      throw new Error(
        `No key for epoch ${this.currentEpoch}. Available: ${[...this.keys.keys()].join(', ') || 'none'}`
      );
    }
    return key;
  }

  /**
   * Returns the key for a specific past or current epoch.
   * @throws If the epoch key is not present (a sync/rotation is required).
   */
  getKeyForEpoch(epochId: number): SymmetricPayloadKey {
    const key = this.keys.get(epochId);
    if (!key) throw new Error(`Missing key for epoch ${epochId}. Sync required.`);
    return key;
  }
}

/**
 * Application-level singleton that holds one `ChannelKeyVault` per channel.
 * Provides convenience methods for encrypting and decrypting channel messages
 * without exposing raw key material to callers.
 */
export class ChannelKeyManager {
  private vaults: Map<string, ChannelKeyVault> = new Map();

  /**
   * Returns (or lazily creates) the vault for `channelId`.
   * The vault starts empty; `rotateKey` must be called before any encrypt/decrypt.
   */
  getVault(channelId: string): ChannelKeyVault {
    if (!this.vaults.has(channelId)) {
      this.vaults.set(channelId, new ChannelKeyVault());
    }
    return this.vaults.get(channelId)!;
  }

  /**
   * Encrypts `payloadBytes` with the current epoch key for `channelId` using AES-GCM.
   * Returns base64-encoded ciphertext and nonce, plus the epoch number so receivers
   * know which key version to use for decryption.
   */
  async encryptMessage(
    channelId: string,
    payloadBytes: Uint8Array
  ): Promise<{ ciphertext: string; nonce: string; keyVersion: number }> {
    const vault = this.getVault(channelId);
    const { key, epochId } = vault.getCurrentKey();

    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      payloadBytes as BufferSource
    );

    // Convert to base64 for transport
    const ciphertextB64 = btoa(String.fromCharCode(...new Uint8Array(encrypted)));
    const nonceB64 = btoa(String.fromCharCode(...nonce));

    return { ciphertext: ciphertextB64, nonce: nonceB64, keyVersion: epochId };
  }

  /**
   * Decrypts a channel message using the key for `keyVersion` (epoch).
   * Both `ciphertextB64` and `nonceB64` must be standard base64-encoded strings
   * as returned by `encryptMessage`.
   */
  async decryptMessage(
    channelId: string,
    ciphertextB64: string,
    nonceB64: string,
    keyVersion: number
  ): Promise<Uint8Array> {
    const vault = this.getVault(channelId);
    const { key } = vault.getKeyForEpoch(keyVersion);

    const ciphertextBytes = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0));
    const nonceBytes = Uint8Array.from(atob(nonceB64), (c) => c.charCodeAt(0));

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonceBytes as BufferSource },
      key,
      ciphertextBytes as BufferSource
    );

    return new Uint8Array(decrypted);
  }
}

export const channelKeyManager = new ChannelKeyManager();
