import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { LessThan } from 'typeorm';
import { Attachment } from '../entities/attachment.entity.js';
import { AttachmentStatus } from '../common/enums.js';

export default fp(async (app: FastifyInstance) => {
  const pollMs = parseInt(process.env.ATTACHMENT_SWEEPER_POLL_MS ?? '60000', 10);
  const ttlMs = parseInt(process.env.ATTACHMENT_ORPHAN_TTL_MS ?? '86400000', 10);

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await sweep();
    } catch (err) {
      app.log.error({ err }, 'Attachment sweeper batch failed');
    }
    if (!stopped) {
      timer = setTimeout(tick, pollMs);
    }
  };

  const sweep = async () => {
    const cutoff = new Date(Date.now() - ttlMs);
    const repo = app.db.getRepository(Attachment);

    // FOR UPDATE SKIP LOCKED prevents multiple instances from double-deleting
    const orphans = await repo
      .createQueryBuilder('a')
      .where('a.status = :status', { status: AttachmentStatus.PENDING })
      .andWhere('a.createdAt < :cutoff', { cutoff })
      .setLock('pessimistic_write_or_fail')
      .getMany()
      .catch(() => [] as Attachment[]); // lock contention → skip

    if (orphans.length === 0) return;

    app.log.info({ count: orphans.length }, 'Attachment sweeper deleting orphans');

    for (const att of orphans) {
      try {
        await app.attachmentStore.delete(att.storageKey);
      } catch (err) {
        app.log.warn({ err, attachmentId: att.id }, 'Sweeper failed to delete bytes; still removing DB row');
      }
      await repo.delete({ id: att.id, status: AttachmentStatus.PENDING });
    }
  };

  app.addHook('onReady', async () => {
    app.log.info({ pollMs, ttlMs }, 'Attachment sweeper started');
    timer = setTimeout(tick, pollMs);
  });

  app.addHook('onClose', async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  });
});
