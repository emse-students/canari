/**
 * StorageService - abstraction over an S3-compatible object store (Garage; formerly MinIO).
 *
 * The service ONLY stores opaque bytes.  It has no knowledge of encryption
 * keys and cannot inspect the content of any uploaded file.
 *
 * Configuration via environment variables:
 *   GARAGE_ENDPOINT          (default: localhost)
 *   GARAGE_PORT              (default: 3900)
 *   GARAGE_USE_SSL           (default: false)
 *   GARAGE_ACCESS_KEY_ID     - the key Garage provisions on first boot, not a second one
 *   GARAGE_SECRET_ACCESS_KEY
 *   GARAGE_BUCKET            (default: canari-media)
 *   GARAGE_REGION            (must match `s3_region` in infrastructure/garage/garage.toml)
 *
 * The `minio` npm package is a generic S3 client and is kept as the client library; nothing
 * about it implies a MinIO server. MinIO itself is gone since the 2026-08-14 cutover
 * (docs/wiki/infrastructure/docker.md).
 */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as Minio from 'minio';
import { Readable } from 'stream';

/** One object as the store describes it. The service never learns anything else about it. */
export interface StoredObject {
  /** Object key, which for chat media is the media id. */
  id: string;
  size: number;
  /**
   * Null when the store did not report one. Kept as a state rather than defaulted to "now" or to
   * the epoch: either default would silently move the object into an age bucket it does not belong
   * in, and the panel's whole job is to say which bucket things are in.
   */
  lastModifiedMs: number | null;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: Minio.Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.GARAGE_BUCKET ?? 'canari-media';
    this.client = new Minio.Client({
      endPoint: process.env.GARAGE_ENDPOINT ?? 'localhost',
      port: parseInt(process.env.GARAGE_PORT ?? '3900', 10),
      useSSL: process.env.GARAGE_USE_SSL === 'true',
      // Garage's S3 API signs with the region declared in garage.toml; the client otherwise
      // defaults to us-east-1 and every request is refused. Not optional here.
      region: process.env.GARAGE_REGION,
      accessKey: (() => {
        const v = process.env.GARAGE_ACCESS_KEY_ID;
        if (!v) throw new Error('GARAGE_ACCESS_KEY_ID is required');
        return v;
      })(),
      secretKey: (() => {
        const v = process.env.GARAGE_SECRET_ACCESS_KEY;
        if (!v) throw new Error('GARAGE_SECRET_ACCESS_KEY is required');
        return v;
      })(),
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
  async putFileStream(objectId: string, filePath: string, _size: number): Promise<void> {
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

  /**
   * Every object in the bucket, with the two facts the admin panel needs about each: how big it is
   * and when it last changed. The S3 client has no bucket-size API, so the full list has to be
   * streamed either way - returning it instead of a running total costs nothing and is what lets
   * the caller tell "media grew" apart from "the retention stopped working" without a second pass.
   *
   * Acceptable at this bucket's current scale (low hundreds of objects); past that it would need
   * the server-side data-usage API, and the panel would lose the per-object breakdown with it.
   */
  async listObjects(): Promise<StoredObject[]> {
    return new Promise((resolve, reject) => {
      const objects: StoredObject[] = [];
      const stream = this.client.listObjectsV2(this.bucket, '', true);
      stream.on('data', (obj) => {
        if (!obj.name) return;
        objects.push({
          id: obj.name,
          size: obj.size ?? 0,
          lastModifiedMs: obj.lastModified ? obj.lastModified.getTime() : null,
        });
      });
      stream.on('end', () => resolve(objects));
      stream.on('error', reject);
    });
  }
}
