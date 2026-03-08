import { Injectable } from '@nestjs/common';
import { StorageService } from './storage.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class MediaService {
  constructor(private readonly storage: StorageService) {}

  async upload(encryptedBytes: Buffer): Promise<string> {
    const mediaId = uuidv4();
    await this.storage.put(mediaId, encryptedBytes, encryptedBytes.length);
    return mediaId;
  }

  async download(mediaId: string): Promise<Buffer | null> {
    return this.storage.get(mediaId);
  }

  async remove(mediaId: string): Promise<void> {
    await this.storage.delete(mediaId);
  }
}
