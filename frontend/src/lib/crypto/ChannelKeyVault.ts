export interface SymmetricPayloadKey {
  epochId: number;
  key: CryptoKey;
  createdAt: number;
}

export class ChannelKeyVault {
  private keys: Map<number, SymmetricPayloadKey> = new Map();
  private currentEpoch: number = 0;

  async rotateKey(newEpochId: number, rawKeyMaterial: Uint8Array) {
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

  getCurrentKey(): SymmetricPayloadKey {
    const key = this.keys.get(this.currentEpoch);
    if (!key) throw new Error('No active key for channel');
    return key;
  }

  getKeyForEpoch(epochId: number): SymmetricPayloadKey {
    const key = this.keys.get(epochId);
    if (!key) throw new Error(`Missing key for epoch ${epochId}. Sync required.`);
    return key;
  }
}

export class ChannelKeyManager {
  private vaults: Map<string, ChannelKeyVault> = new Map();

  getVault(channelId: string): ChannelKeyVault {
    if (!this.vaults.has(channelId)) {
      this.vaults.set(channelId, new ChannelKeyVault());
    }
    return this.vaults.get(channelId)!;
  }

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
