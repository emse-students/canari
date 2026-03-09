/**
 * StorageService – abstraction over MinIO (S3-compatible object storage).
 *
 * The service ONLY stores opaque bytes.  It has no knowledge of encryption
 * keys and cannot inspect the content of any uploaded file.
 *
 * Configuration via environment variables:
 *   MINIO_ENDPOINT  (default: localhost)
 *   MINIO_PORT      (default: 9100)
 *   MINIO_USE_SSL   (default: false)
 *   MINIO_ACCESS_KEY
 *   MINIO_SECRET_KEY
 *   MINIO_BUCKET    (default: canari-media)
 */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as Minio from 'minio';
import { Readable } from 'stream';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: Minio.Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.MINIO_BUCKET ?? 'canari-media';
    this.client = new Minio.Client({
      endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
      port: parseInt(process.env.MINIO_PORT ?? '9100', 10),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
      secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
    });
  }

  async onModuleInit() {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
      this.logger.log(`Created bucket: ${this.bucket}`);
    }
  }

  /**
   * Store an opaque encrypted blob.
   * @param objectId  Pre-generated UUID used as the object key.
   * @param data      Raw encrypted bytes (the server never decrypts this).
   * @param size      Size in bytes (required by MinIO client).
   */
  async put(objectId: string, data: Buffer, size: number): Promise<void> {
    const stream = Readable.from(data);
    await this.client.putObject(this.bucket, objectId, stream, size, {
      'Content-Type': 'application/octet-stream',
      'x-amz-meta-encrypted': 'true',
    });
  }

  /**
   * Store an opaque encrypted blob from a local file.
   */
  async putFileStream(objectId: string, filePath: string, size: number): Promise<void> {
    await this.client.fPutObject(this.bucket, objectId, filePath, {
      'Content-Type': 'application/octet-stream',
      'x-amz-meta-encrypted': 'true',
    });
  }

  /**
   * Retrieve an encrypted blob as a stream. Returns null if not found.
   */
  async get(objectId: string): Promise<Readable | null> {
    try {
      return await this.client.getObject(this.bucket, objectId);
    } catch (err: any) {
      if (err?.code === 'NoSuchKey') return null;
      throw err;
    }
  }

  /** Delete a stored blob. */
  async delete(objectId: string): Promise<void> {
    await this.client.removeObject(this.bucket, objectId);
  }
}
