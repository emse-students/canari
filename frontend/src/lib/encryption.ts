export async function encryptData(
  data: any,
  pin: string
): Promise<{ iv: Uint8Array; salt: Uint8Array; cipherText: Uint8Array }> {
  // Dynamic import to access WASM memory (must be initialized by Service)
  const wasm = await import('$lib/wasm/mls_wasm.js');

  // Check if initialized
  if (!wasm.encrypt_with_pin) {
    throw new Error('WASM not initialized or missing export');
  }

  const enc = new TextEncoder();
  const encoded = enc.encode(JSON.stringify(data));

  try {
    const fullBlob: Uint8Array = wasm.encrypt_with_pin(pin, encoded);

    // Output format from Rust: [Salt 16] [Nonce 12] [Ciphertext ...]
    const salt = fullBlob.slice(0, 16);
    const iv = fullBlob.slice(16, 28);
    const cipherText = fullBlob.slice(28);

    return { iv, salt, cipherText };
  } catch (e) {
    throw new Error(`WASM Encryption failed: ${e}`);
  }
}

export async function decryptData(
  cipherText: Uint8Array,
  iv: Uint8Array,
  salt: Uint8Array,
  pin: string
): Promise<any> {
  const wasm = await import('$lib/wasm/mls_wasm.js');

  // Reconstruct blob: [Salt 16] [Nonce 12] [Ciphertext ...]
  const fullBlob = new Uint8Array(salt.length + iv.length + cipherText.length);
  fullBlob.set(salt, 0);
  fullBlob.set(iv, 16);
  fullBlob.set(cipherText, 28);

  try {
    const decrypted: Uint8Array = wasm.decrypt_with_pin(pin, fullBlob);

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decrypted));
  } catch {
    throw new Error('Decryption failed. Wrong PIN?');
  }
}
