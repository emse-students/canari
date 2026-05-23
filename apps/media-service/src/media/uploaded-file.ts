import { PayloadTooLargeException } from '@nestjs/common';

/** Minimal Multer upload shape (structural type avoids Express/Multer namespace conflicts). */
export interface UploadedFilePayload {
  buffer: Buffer;
  size: number;
  mimetype?: string;
}

function isUploadedFilePayload(file: unknown): file is UploadedFilePayload {
  if (!file || typeof file !== 'object') return false;
  const candidate = file as { buffer?: unknown; size?: unknown };
  return Buffer.isBuffer(candidate.buffer) && typeof candidate.size === 'number';
}

/** Normalizes a Multer upload to a Node `Buffer`. */
export function uploadedFileBuffer(file: unknown): Buffer {
  if (!isUploadedFilePayload(file)) {
    throw new PayloadTooLargeException('No file provided');
  }
  return file.buffer;
}

/** MIME type from a Multer upload, lowercased. */
export function uploadedFileMime(file: UploadedFilePayload): string {
  return file.mimetype?.toLowerCase() ?? '';
}

/** Returns the upload payload or throws if the request had no file. */
export function requireUploadedFile(file: unknown): UploadedFilePayload {
  if (!isUploadedFilePayload(file)) {
    throw new PayloadTooLargeException('No file provided');
  }
  return file;
}
