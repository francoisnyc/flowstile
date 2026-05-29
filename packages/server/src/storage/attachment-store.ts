import { Readable } from 'node:stream';

export interface PutResult {
  storageKey: string;
  size: number;
  checksum: string; // hex sha256
}

export interface AttachmentStore {
  put(stream: Readable, opts: { contentType: string }): Promise<PutResult>;
  get(storageKey: string): Promise<Readable>;
  delete(storageKey: string): Promise<void>;
}
