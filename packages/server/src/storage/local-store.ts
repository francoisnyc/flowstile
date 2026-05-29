import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AttachmentStore, PutResult } from './attachment-store.js';

export class LocalAttachmentStore implements AttachmentStore {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  private keyToPath(key: string): string {
    // Shard: ab/cd/<uuid> to avoid too many files in one directory
    return join(this.basePath, key.slice(0, 2), key.slice(2, 4), key);
  }

  async put(stream: Readable, _opts: { contentType: string }): Promise<PutResult> {
    const key = randomUUID();
    const finalPath = this.keyToPath(key);
    const tmpPath = finalPath + '.tmp';

    await mkdir(join(this.basePath, key.slice(0, 2), key.slice(2, 4)), { recursive: true });

    const hash = createHash('sha256');
    let size = 0;

    const writeStream = createWriteStream(tmpPath);

    // Tee: write to disk and hash simultaneously
    await pipeline(
      stream,
      async function* (source) {
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          hash.update(buf);
          size += buf.length;
          yield buf;
        }
      },
      writeStream,
    );

    // fsync before rename for crash safety
    const fd = await open(tmpPath, 'r');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }

    await rename(tmpPath, finalPath);

    return { storageKey: key, size, checksum: hash.digest('hex') };
  }

  async get(storageKey: string): Promise<Readable> {
    return createReadStream(this.keyToPath(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await rm(this.keyToPath(storageKey));
    } catch (err: unknown) {
      // Missing file on delete is not an error
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
