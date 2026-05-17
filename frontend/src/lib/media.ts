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

/** Presets par contexte — qualité plus haute, resize moins agressif. */
export const IMAGE_COMPRESS_PRESETS = {
  chat: { maxWidth: 2560, maxHeight: 2560, quality: 0.92 },
  post: { maxWidth: 2048, maxHeight: 2048, quality: 0.92 },
  comment: { maxWidth: 1280, maxHeight: 1280, quality: 0.9 },
} as const;

/** Sous ce seuil, on garde l'original si aucun redimensionnement n'est nécessaire. */
const SKIP_REENCODE_UNDER_BYTES = 2 * 1024 * 1024;

/** N'accepte la version WebP que si elle fait au moins 15 % de moins que l'original. */
const MIN_SIZE_SAVINGS_RATIO = 0.85;

import { decryptMediaBuffer, encryptMediaBuffer } from '$lib/mediaCrypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compress an image file using canvas.
 *
 * @param file The original image file
 * @param maxWidth Maximum width (default: 2560)
 * @param maxHeight Maximum height (default: 2560)
 * @param quality WebP quality 0-1 (default: 0.92)
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
  maxWidth: number = IMAGE_COMPRESS_PRESETS.chat.maxWidth,
  maxHeight: number = IMAGE_COMPRESS_PRESETS.chat.maxHeight,
  quality: number = IMAGE_COMPRESS_PRESETS.chat.quality
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
        const needsResize = width !== img.naturalWidth || height !== img.naturalHeight;

        if (!needsResize && file.size < SKIP_REENCODE_UNDER_BYTES) {
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

            const worthReplacing =
              blob.size <= file.size * MIN_SIZE_SAVINGS_RATIO ||
              (needsResize && blob.size < file.size);

            if (worthReplacing) {
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
    const plaintext = await file.arrayBuffer();
    const { ciphertext, keyHex, ivHex } = await encryptMediaBuffer(plaintext);

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
    const plaintext = await decryptMediaBuffer(ciphertext, ref.key, ref.iv);

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
