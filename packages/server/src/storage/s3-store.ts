/* eslint-disable @typescript-eslint/no-explicit-any */
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { AttachmentStore, PutResult } from './attachment-store.js';

// S3 client is lazy-imported so @aws-sdk/client-s3 is not loaded when using local storage.

interface S3Config {
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
}

export class S3AttachmentStore implements AttachmentStore {
  private readonly cfg: S3Config;
  private client: any = null;

  constructor(cfg: S3Config) {
    this.cfg = cfg;
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    // Dynamic import to avoid loading @aws-sdk when using local storage
    const mod = await (Function('s', 'return import(s)')('@aws-sdk/client-s3') as Promise<any>);
    this.client = new mod.S3Client({
      region: this.cfg.region,
      ...(this.cfg.endpoint ? { endpoint: this.cfg.endpoint } : {}),
      ...(this.cfg.accessKeyId
        ? { credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey! } }
        : {}),
    });
    return this.client;
  }

  private objectKey(storageKey: string): string {
    const prefix = this.cfg.prefix ? `${this.cfg.prefix}/` : '';
    return `${prefix}${storageKey}`;
  }

  async put(stream: Readable, opts: { contentType: string }): Promise<PutResult> {
    const libStorage = await (Function('s', 'return import(s)')('@aws-sdk/lib-storage') as Promise<any>);
    const { randomUUID } = await import('node:crypto');

    const storageKey = randomUUID();
    const hash = createHash('sha256');
    let size = 0;

    const measuredStream = Readable.from(
      (async function* () {
        for await (const chunk of stream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          hash.update(buf);
          size += buf.length;
          yield buf;
        }
      })(),
    );

    const client = await this.getClient();
    const upload = new libStorage.Upload({
      client,
      params: {
        Bucket: this.cfg.bucket,
        Key: this.objectKey(storageKey),
        Body: measuredStream,
        ContentType: opts.contentType,
      },
    });

    await upload.done();

    return { storageKey, size, checksum: hash.digest('hex') };
  }

  async get(storageKey: string): Promise<Readable> {
    const mod = await (Function('s', 'return import(s)')('@aws-sdk/client-s3') as Promise<any>);
    const client = await this.getClient();
    const resp = await client.send(new mod.GetObjectCommand({
      Bucket: this.cfg.bucket,
      Key: this.objectKey(storageKey),
    }));
    return resp.Body as Readable;
  }

  async delete(storageKey: string): Promise<void> {
    const mod = await (Function('s', 'return import(s)')('@aws-sdk/client-s3') as Promise<any>);
    const client = await this.getClient();
    await client.send(new mod.DeleteObjectCommand({
      Bucket: this.cfg.bucket,
      Key: this.objectKey(storageKey),
    }));
  }
}
