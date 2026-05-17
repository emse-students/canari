/**
 * media.ts – Client-side media encryption / upload / download
 *
 * Security model
 * ──────────────
 * The media service stores ONLY opaque ciphertext blobs.  The decryption key
 * is never sent to or stored on the server.  Instead it is embedded inside the
 * MLS-encrypted application message, so:
 *
 *  - Only group members can decrypt the content.
 *  - The key inherits MLS forward secrecy and group membership control.
 *  - Key rotation is handled naturally by MLS epoch changes.
 *  - Works identically for 1-to-1 chats (2-member group) and multi-party groups.
 *
 * Encryption scheme: AES-256-GCM (via SubtleCrypto – no extra dependency)
 *   - 256-bit random CEK (Content Encryption Key) per file
 *   - 96-bit random IV per file
 *   - Authentication tag is appended by SubtleCrypto automatically (16 bytes)
 *
 * Wire format embedded in the MLS message (JSON string):
 * {
 *   "type":     "image" | "video" | "file",
 *   "mediaId":  string,          // opaque server-side id
 *   "key":      string,          // hex-encoded 32-byte CEK
 *   "iv":       string,          // hex-encoded 12-byte IV
 *   "mimeType": string,
 *   "size":     number,          // original (plaintext) file size in bytes
 *   "fileName": string | undefined
 * }
 *
 * Messages that do NOT match this shape are treated as plain text (backward compat).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaType = 'image' | 'video' | 'audio' | 'file';

export interface MediaRef {
  type: MediaType;
  /** Opaque identifier returned by the media service upload endpoint. */
  mediaId: string;
  /** Hex-encoded 32-byte AES-256-GCM Content Encryption Key. */
  key: string;
  /** Hex-encoded 12-byte IV / nonce. */
  iv: string;
  mimeType: string;
  /** Plaintext file size in bytes (for progress / display). */
  size: number;
  fileName?: string;
  /** Display width in px (after compression), used to reserve layout before decrypt. */
  width?: number;
  /** Display height in px (after compression), used to reserve layout before decrypt. */
  height?: number;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface CompressedImage {
  file: File;
  width: number;
  height: number;
}

/** File staged for send with optional display dimensions (images). */
export interface PendingMediaFile {
  file: File;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a byte array to a lowercase hexadecimal string (e.g. key or IV for wire format). */
function hexEncode(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Decode a lowercase hexadecimal string back to a byte array (inverse of hexEncode). */
function hexDecode(hex: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array((hex.match(/.{1,2}/g) ?? []).map((b) => parseInt(b, 16)));
}

/**
 * Compress an image file using canvas.
 *
 * @param file The original image file
 * @param maxWidth Maximum width (default: 1920)
 * @param maxHeight Maximum height (default: 1080)
 * @param quality JPEG/WebP quality 0-1 (default: 0.85)
 * @returns Compressed file (or original) with final display dimensions
 */
export async function readImageDimensions(file: File): Promise<ImageDimensions | null> {
  if (!file.type.startsWith('image/')) return null;

  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      if (width > 0 && height > 0) resolve({ width, height });
      else resolve(null);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(null);
    };
    img.src = objectUrl;
  });
}

export async function compressImage(
  file: File,
  maxWidth = 1920,
  maxHeight = 1080,
  quality = 0.85
): Promise<CompressedImage> {
  if (!file.type.startsWith('image/')) {
    return { file, width: 0, height: 0 };
  }

  if (file.type === 'image/gif' || file.type === 'image/svg+xml') {
    const dims = await readImageDimensions(file);
    return { file, width: dims?.width ?? 0, height: dims?.height ?? 0 };
  }

  try {
    return await new Promise((resolve) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        void readImageDimensions(file).then((dims) =>
          resolve({ file, width: dims?.width ?? 0, height: dims?.height ?? 0 })
        );
        return;
      }

      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        let { width, height } = img;

        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.floor(width * ratio);
          height = Math.floor(height * ratio);
        }

        const outWidth = width;
        const outHeight = height;

        if (width === img.width && height === img.height && file.size < 500 * 1024) {
          resolve({ file, width: outWidth, height: outHeight });
          return;
        }

        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);

        const outputType = 'image/webp';
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              resolve({ file, width: outWidth, height: outHeight });
              return;
            }

            if (blob.size < file.size) {
              resolve({
                file: new File([blob], file.name, { type: outputType, lastModified: Date.now() }),
                width: outWidth,
                height: outHeight,
              });
            } else {
              resolve({ file, width: outWidth, height: outHeight });
            }
          },
          outputType,
          quality
        );
      };

      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        void readImageDimensions(file).then((dims) =>
          resolve({ file, width: dims?.width ?? 0, height: dims?.height ?? 0 })
        );
      };
      img.src = objectUrl;
    });
  } catch (error) {
    console.warn('Image compression failed:', error);
    const dims = await readImageDimensions(file);
    return { file, width: dims?.width ?? 0, height: dims?.height ?? 0 };
  }
}

/**
 * Parse a message content string.
 * Returns the MediaRef if it is a media message, or null if it is plain text.
 */
export function parseMediaMessage(content: string): MediaRef | null {
  if (!content.startsWith('{')) return null;
  try {
    const obj = JSON.parse(content);
    // __media sentinel is required to prevent crafted JSON text from being
    // misinterpreted as a media attachment.
    if (
      obj.__media === true &&
      (obj.type === 'image' ||
        obj.type === 'video' ||
        obj.type === 'audio' ||
        obj.type === 'file') &&
      typeof obj.mediaId === 'string' &&
      typeof obj.key === 'string' &&
      typeof obj.iv === 'string'
    ) {
      return obj as MediaRef;
    }
  } catch {
    // Not JSON – treat as plain text
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core crypto (SubtleCrypto – available in all modern browsers and Tauri)
// ---------------------------------------------------------------------------

/** Generate a fresh 256-bit AES-GCM Content Encryption Key and return it as both a CryptoKey and a hex string. */
async function generateCek(): Promise<{ cryptoKey: CryptoKey; keyHex: string }> {
  const cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const raw = await crypto.subtle.exportKey('raw', cryptoKey);
  return { cryptoKey, keyHex: hexEncode(new Uint8Array(raw)) };
}

/** Re-import a hex-encoded CEK as a non-extractable CryptoKey configured for AES-256-GCM decryption. */
async function importCek(keyHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    hexDecode(keyHex),
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

/** Generate a fresh 12-byte random initialization vector (nonce) for AES-256-GCM. */
function generateIv(): { iv: Uint8Array<ArrayBuffer>; ivHex: string } {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  return { iv, ivHex: hexEncode(iv) };
}

// ---------------------------------------------------------------------------
// MediaService
// ---------------------------------------------------------------------------

/**
 * Client-side media operations: encrypt-then-upload and download-then-decrypt.
 * The decryption key (CEK) is never transmitted to or stored on the server — it is embedded inside
 * the MLS-encrypted application message so only group members can decrypt the attachment.
 */
export class MediaService {
  private readonly baseUrl: string;

  /**
   * @param baseUrl Optional override for the media service base URL.
   *   Defaults to the `VITE_MEDIA_URL` env var, then `window.location.origin`.
   */
  constructor(baseUrl?: string) {
    const env = typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_MEDIA_URL;
    const fallback =
      typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3011';
    this.baseUrl = (baseUrl ?? env ?? '').replace(/\/$/, '') || fallback;
  }

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  /**
   * Encrypt `file` client-side and upload the ciphertext to the media service.
   *
   * @param file       The raw File object selected by the user.
   * @param authToken  JWT token sent in the Authorization header.
   * @returns          A `MediaRef` ready to be JSON-serialised and embedded
   *                   inside the MLS application message.
   */
  async encryptAndUpload(
    file: File,
    authToken: string,
    dimensions?: Partial<ImageDimensions>
  ): Promise<MediaRef> {
    // 1. Generate a fresh CEK and IV for this file
    const { cryptoKey, keyHex } = await generateCek();
    const { iv, ivHex } = generateIv();

    // 2. Encrypt the file bytes
    const plaintext = await file.arrayBuffer();
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext);

    // 3. Upload the encrypted blob (server stores opaque bytes, no key)
    const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB
    let mediaId: string;

    if (ciphertext.byteLength > CHUNK_SIZE) {
      // Chunked upload for large files (>50MB) to bypass limits
      // 3.1 Initialize chunked upload
      const initRes = await fetch(`${this.baseUrl}/api/media/upload/chunk/init`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!initRes.ok) {
        throw new Error(`Chunked upload init failed: ${initRes.status}`);
      }
      const { uploadId } = await initRes.json();

      // 3.2 Upload chunks
      const totalChunks = Math.ceil(ciphertext.byteLength / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, ciphertext.byteLength);
        const chunk = ciphertext.slice(start, end);
        const chunkFormData = new FormData();
        chunkFormData.append(
          'chunk',
          new Blob([chunk], { type: 'application/octet-stream' }),
          'chunk'
        );

        const chunkRes = await fetch(`${this.baseUrl}/api/media/upload/chunk/${uploadId}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
          body: chunkFormData,
        });
        if (!chunkRes.ok) {
          throw new Error(
            `Chunk upload failed at chunk ${i + 1}/${totalChunks}: ${chunkRes.status}`
          );
        }
      }

      // 3.3 Complete chunked upload
      const completeRes = await fetch(
        `${this.baseUrl}/api/media/upload/chunk/${uploadId}/complete`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
        }
      );
      if (!completeRes.ok) {
        throw new Error(`Chunked upload complete failed: ${completeRes.status}`);
      }
      const completeData = await completeRes.json();
      mediaId = completeData.mediaId;
    } else {
      // Standard single-request upload
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([ciphertext], { type: 'application/octet-stream' }),
        'encrypted'
      );

      const res = await fetch(`${this.baseUrl}/api/media/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: formData,
      });

      if (!res.ok) {
        const responseText = await res.text();
        const details = responseText ? ` - ${responseText}` : '';
        if (res.status === 413) {
          throw new Error('Media upload failed: 413 (fichier trop volumineux)');
        }
        throw new Error(`Media upload failed: ${res.status} ${res.statusText}${details}`);
      }

      const data = await res.json();
      mediaId = data.mediaId;
    }

    if (typeof mediaId !== 'string') {
      throw new Error('Media service returned no mediaId');
    }

    // 4. Return the reference – the key is only here, never on the server
    const type = file.type.startsWith('video/')
      ? 'video'
      : file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('audio/')
          ? 'audio'
          : 'file';

    const width =
      dimensions?.width && dimensions.width > 0 ? Math.round(dimensions.width) : undefined;
    const height =
      dimensions?.height && dimensions.height > 0 ? Math.round(dimensions.height) : undefined;

    return {
      type,
      mediaId,
      key: keyHex,
      iv: ivHex,
      mimeType: file.type,
      size: file.size,
      fileName: file.name,
      ...(width && height ? { width, height } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  /**
   * Download the encrypted blob and decrypt it client-side.
   *
   * @param ref        The `MediaRef` extracted from the MLS message.
   * @param authToken  JWT token.
   * @returns          A temporary object URL (`blob:…`) valid for this session.
   *                   The caller is responsible for calling `URL.revokeObjectURL`
   *                   when the element is removed.
   */
  async downloadAndDecrypt(ref: MediaRef, authToken: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/media/${ref.mediaId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    if (!res.ok) {
      if (res.status === 410) {
        throw new Error('MEDIA_PURGED_BY_RETENTION');
      }
      throw new Error(`Media download failed: ${res.status} ${res.statusText}`);
    }

    const ciphertext = await res.arrayBuffer();
    const cryptoKey = await importCek(ref.key);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexDecode(ref.iv) },
      cryptoKey,
      ciphertext
    );

    const blob = new Blob([plaintext], { type: ref.mimeType });
    return URL.createObjectURL(blob);
  }

  // -------------------------------------------------------------------------
  // Raw (unencrypted) upload / download — for group & community avatars
  // -------------------------------------------------------------------------

  /**
   * Upload a file to the media service without client-side encryption.
   * Suitable for group/community avatars that don't require E2E secrecy.
   *
   * @param file        The image File selected by the user.
   * @param authToken   JWT token.
   * @returns           The opaque `mediaId` from the server.
   */
  async uploadRaw(file: File, authToken: string): Promise<string> {
    const formData = new FormData();
    formData.append('file', file, file.name);

    const res = await fetch(`${this.baseUrl}/api/media/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Avatar upload failed: ${res.status}${text ? ` — ${text}` : ''}`);
    }

    const data = await res.json();
    if (typeof data.mediaId !== 'string') throw new Error('Media service returned no mediaId');
    return data.mediaId;
  }

  /**
   * Download a raw (unencrypted) blob from the media service and return an
   * object URL for use in an `<img>` element.
   *
   * The caller is responsible for calling `URL.revokeObjectURL` when done.
   *
   * @param mediaId    The opaque identifier returned by `uploadRaw`.
   * @param authToken  JWT token.
   */
  async downloadRaw(mediaId: string, authToken: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/media/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    if (!res.ok) {
      if (res.status === 410) throw new Error('MEDIA_PURGED_BY_RETENTION');
      throw new Error(`Avatar download failed: ${res.status}`);
    }

    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }
}
