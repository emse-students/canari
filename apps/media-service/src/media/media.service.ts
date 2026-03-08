import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from './storage.service';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs-extra';
import * as path from 'path';

const CHUNK_DIR = path.join(process.cwd(), 'chunks_temp');

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(private readonly storage: StorageService) {
    fs.ensureDirSync(CHUNK_DIR);
  }

  async upload(encryptedBytes: Buffer): Promise<string> {
    const mediaId = uuidv4();
    await this.storage.put(mediaId, encryptedBytes, encryptedBytes.length);
    return mediaId;
  }

  async download(mediaId: string): Promise<Buffer | null> {
    const stream = await this.storage.get(mediaId);
    if (!stream) return null;

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  }

  async remove(mediaId: string): Promise<void> {
    await this.storage.delete(mediaId);
  }

  // --- Chunked upload ---

  async initChunkedUpload(): Promise<string> {
    const uploadId = uuidv4();
    const tempFile = path.join(CHUNK_DIR, uploadId);
    await fs.ensureFile(tempFile);
    return uploadId;
  }

  async appendChunk(uploadId: string, chunk: Buffer): Promise<void> {
    // We assume sequential chunk upload for simplicity.
    // The client should await each part or we save per part_index and combine.
    // Given the context, sequential client uploads are easiest.
    const tempFile = path.join(CHUNK_DIR, uploadId);
    if (!(await fs.pathExists(tempFile))) {
      throw new Error('Upload session not found or expired');
    }
    await fs.appendFile(tempFile, chunk);
  }

  async completeChunkedUpload(uploadId: string): Promise<string> {
    const tempFile = path.join(CHUNK_DIR, uploadId);
    if (!(await fs.pathExists(tempFile))) {
      throw new Error('Upload session not found or expired');
    }

    const stat = await fs.stat(tempFile);
    const mediaId = uuidv4();

    // Stream from local temp file to MinIO
    await this.storage.putFileStream(mediaId, tempFile, stat.size);

    // Clean up
    await fs.remove(tempFile);

    return mediaId;
  }
}
