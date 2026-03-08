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

export type MediaType = 'image' | 'video' | 'file';

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexEncode(buf: Uint8Array): string {
    return Array.from(buf)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

function hexDecode(hex: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array((hex.match(/.{1,2}/g) ?? []).map((b) => parseInt(b, 16)));
}

/**
 * Parse a message content string.
 * Returns the MediaRef if it is a media message, or null if it is plain text.
 */
export function parseMediaMessage(content: string): MediaRef | null {
    if (!content.startsWith('{')) return null;
    try {
        const obj = JSON.parse(content);
        if (
            (obj.type === 'image' || obj.type === 'video' || obj.type === 'file') &&
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

async function generateCek(): Promise<{ cryptoKey: CryptoKey; keyHex: string }> {
    const cryptoKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
    );
    const raw = await crypto.subtle.exportKey('raw', cryptoKey);
    return { cryptoKey, keyHex: hexEncode(new Uint8Array(raw)) };
}

async function importCek(keyHex: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'raw',
        hexDecode(keyHex),
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt']
    );
}

function generateIv(): { iv: Uint8Array<ArrayBuffer>; ivHex: string } {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    return { iv, ivHex: hexEncode(iv) };
}

// ---------------------------------------------------------------------------
// MediaService
// ---------------------------------------------------------------------------

export class MediaService {
    private readonly baseUrl: string;

    constructor(baseUrl?: string) {
        const env = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_MEDIA_URL);
        const fallback = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3002';
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
    async encryptAndUpload(file: File, authToken: string): Promise<MediaRef> {
        // 1. Generate a fresh CEK and IV for this file
        const { cryptoKey, keyHex } = await generateCek();
        const { iv, ivHex } = generateIv();

        // 2. Encrypt the file bytes
        const plaintext = await file.arrayBuffer();
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            cryptoKey,
            plaintext
        );

        // 3. Upload the encrypted blob (server stores opaque bytes, no key)
        const formData = new FormData();
        formData.append(
            'file',
            new Blob([ciphertext], { type: 'application/octet-stream' }),
            'encrypted'
        );

        const res = await fetch(`${this.baseUrl}/media/upload`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${authToken}` },
            body: formData,
        });

        if (!res.ok) {
            throw new Error(`Media upload failed: ${res.status} ${res.statusText}`);
        }

        const { mediaId } = await res.json();
        if (typeof mediaId !== 'string') {
            throw new Error('Media service returned no mediaId');
        }

        // 4. Return the reference – the key is only here, never on the server
        const type = file.type.startsWith('video/')
            ? 'video'
            : file.type.startsWith('image/')
              ? 'image'
              : 'file';

        return {
            type,
            mediaId,
            key: keyHex,
            iv: ivHex,
            mimeType: file.type,
            size: file.size,
            fileName: file.name,
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
        const res = await fetch(`${this.baseUrl}/media/${ref.mediaId}`, {
            headers: { Authorization: `Bearer ${authToken}` },
        });

        if (!res.ok) {
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
}
