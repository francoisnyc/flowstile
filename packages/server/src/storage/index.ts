import type { AttachmentStore } from './attachment-store.js';
import { LocalAttachmentStore } from './local-store.js';

export type { AttachmentStore, PutResult } from './attachment-store.js';

export function createAttachmentStore(env: NodeJS.ProcessEnv): AttachmentStore {
  const backend = env.ATTACHMENT_STORE ?? 'local';

  if (backend === 's3') {
    const bucket = env.ATTACHMENT_S3_BUCKET;
    const region = env.ATTACHMENT_S3_REGION;
    if (!bucket || !region) {
      throw new Error('ATTACHMENT_S3_BUCKET and ATTACHMENT_S3_REGION are required when ATTACHMENT_STORE=s3');
    }
    // Dynamic import keeps @aws-sdk out of the local hot path
    const { S3AttachmentStore } = require('./s3-store.js') as typeof import('./s3-store.js');
    return new S3AttachmentStore({
      bucket,
      region,
      prefix: env.ATTACHMENT_S3_PREFIX ?? 'attachments',
      accessKeyId: env.ATTACHMENT_S3_ACCESS_KEY_ID,
      secretAccessKey: env.ATTACHMENT_S3_SECRET_ACCESS_KEY,
      endpoint: env.ATTACHMENT_S3_ENDPOINT,
    });
  }

  const path = env.ATTACHMENT_LOCAL_PATH ?? './.attachments';
  return new LocalAttachmentStore(path);
}
