import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { createAttachmentStore, type AttachmentStore } from '../storage/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    attachmentStore: AttachmentStore;
  }
}

export default fp(async (app: FastifyInstance) => {
  const store = createAttachmentStore(process.env);
  app.decorate('attachmentStore', store);
});
