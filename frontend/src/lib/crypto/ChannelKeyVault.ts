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
