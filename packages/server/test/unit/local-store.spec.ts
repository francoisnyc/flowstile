import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAttachmentStore } from '../../src/storage/local-store.js';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

describe('LocalAttachmentStore', () => {
  let dir: string;
  let store: LocalAttachmentStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'att-test-'));
    store = new LocalAttachmentStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('put/get round-trip preserves content', async () => {
    const content = Buffer.from('hello world');
    const { storageKey } = await store.put(Readable.from(content), { contentType: 'text/plain' });
    const stream = await store.get(storageKey);
    const result = await collect(stream);
    expect(result).toEqual(content);
  });

  it('put returns correct size', async () => {
    const content = Buffer.from('hello world');
    const { size } = await store.put(Readable.from(content), { contentType: 'text/plain' });
    expect(size).toBe(content.length);
  });

  it('put returns correct sha256 checksum', async () => {
    const content = Buffer.from('hello world');
    const expected = createHash('sha256').update(content).digest('hex');
    const { checksum } = await store.put(Readable.from(content), { contentType: 'text/plain' });
    expect(checksum).toBe(expected);
  });

  it('put generates unique keys', async () => {
    const content = Buffer.from('data');
    const r1 = await store.put(Readable.from(content), { contentType: 'text/plain' });
    const r2 = await store.put(Readable.from(content), { contentType: 'text/plain' });
    expect(r1.storageKey).not.toBe(r2.storageKey);
  });

  it('delete removes the file', async () => {
    const content = Buffer.from('bye');
    const { storageKey } = await store.put(Readable.from(content), { contentType: 'text/plain' });
    await store.delete(storageKey);
    await expect(collect(await store.get(storageKey))).rejects.toThrow();
  });

  it('delete of missing key is a no-op', async () => {
    await expect(store.delete('non-existent-key')).resolves.toBeUndefined();
  });
});
