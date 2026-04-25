export function toHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const B64_PREFIX = 'b64:';

export function saveMlsState(userId: string, bytes: Uint8Array): void {
  localStorage.setItem('mls_autosave_' + userId, B64_PREFIX + toBase64(bytes));
}

export function loadMlsState(userId: string): Uint8Array | null {
  const saved = localStorage.getItem('mls_autosave_' + userId);
  if (!saved) return null;
  if (saved.startsWith(B64_PREFIX)) return fromBase64(saved.slice(B64_PREFIX.length));
  // Migration: old hex format — decode and let the next save re-encode as base64
  return fromHex(saved);
}

/** Returns the MLS state as hex for backup file format (backward-compatible). */
export function exportMlsStateAsHex(userId: string): string | undefined {
  const bytes = loadMlsState(userId);
  return bytes ? toHex(bytes) : undefined;
}
