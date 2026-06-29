import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { Attachment } from '../entities/attachment.entity.js';
import { FormDefinition } from '../entities/form-definition.entity.js';
import { Task } from '../entities/task.entity.js';
import { AttachmentStatus, TaskStatus } from '../common/enums.js';
import { toReference, findAttachmentFields } from '../common/attachments.js';
import { filterFormSchemas } from '../common/visibility.js';
import { requirePermission, requireUser } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';

const UuidParam = z.object({ id: z.string().uuid() });
const AttachmentParam = z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() });

const ATTACHMENT_MAX_BYTES = parseInt(process.env.ATTACHMENT_MAX_BYTES ?? String(25 * 1024 * 1024), 10);
const ATTACHMENT_STORE_ID = process.env.ATTACHMENT_STORE ?? 'local';

export const attachmentRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = { preHandler: [requirePermission(Permissions.TASKS_READ)] };
  const write = { preHandler: [requirePermission(Permissions.TASKS_WRITE)] };

  // POST /tasks/:id/attachments  — upload a file, get back a pending reference
  app.post(
    '/tasks/:id/attachments',
    {
      ...write,
      schema: { params: UuidParam, tags: ['Attachments'] },
    },
    async (request, reply) => {
      const { id: taskId } = request.params;
      const user = requireUser(request, reply);
      if (!user) return reply;

      const task = await app.db.getRepository(Task).findOne({
        where: { id: taskId },
        relations: ['taskDefinition'],
      });
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.CANCELLED) {
        return reply.code(409).send({ error: 'Cannot upload to a terminal task' });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any;
      try {
        data = await request.file({ limits: { fileSize: ATTACHMENT_MAX_BYTES + 1 } });
      } catch {
        return reply.code(400).send({ error: 'Expected a multipart file upload' });
      }

      if (!data) {
        return reply.code(400).send({ error: 'No file found in multipart request' });
      }

      // Stream to store; @fastify/multipart signals overflow by emitting limit event
      let limitHit = false;
      data.file.once('limit', () => { limitHit = true; });

      let putResult: Awaited<ReturnType<typeof app.attachmentStore.put>>;
      try {
        putResult = await app.attachmentStore.put(data.file, { contentType: data.mimetype });
      } catch (err) {
        if (limitHit) {
          return reply.code(413).send({ error: `File exceeds maximum size of ${ATTACHMENT_MAX_BYTES} bytes` });
        }
        throw err;
      }

      if (limitHit) {
        // Delete the partial upload from the store then return 413
        await app.attachmentStore.delete(putResult.storageKey).catch(() => { /* best-effort */ });
        return reply.code(413).send({ error: `File exceeds maximum size of ${ATTACHMENT_MAX_BYTES} bytes` });
      }

      const att = await app.db.getRepository(Attachment).save({
        taskId,
        storageKey: putResult.storageKey,
        storeId: ATTACHMENT_STORE_ID,
        fileName: data.filename || 'upload',
        contentType: data.mimetype || 'application/octet-stream',
        size: putResult.size,
        checksum: putResult.checksum,
        uploadedById: user.id,
        status: AttachmentStatus.PENDING,
      });

      return reply.code(201).send(toReference(att));
    },
  );

  // GET /tasks/:id/attachments/:attachmentId/content  — download
  app.get(
    '/tasks/:id/attachments/:attachmentId/content',
    { ...read, schema: { params: AttachmentParam, tags: ['Attachments'] } },
    async (request, reply) => {
      const { id: taskId, attachmentId } = request.params;
      const user = requireUser(request, reply);
      if (!user) return reply;

      const att = await app.db.getRepository(Attachment).findOne({
        where: { id: attachmentId },
      });
      if (!att || att.taskId !== taskId) {
        return reply.code(404).send({ error: 'Attachment not found' });
      }

      const task = await app.db.getRepository(Task).findOne({
        where: { id: taskId },
        relations: ['taskDefinition'],
      });
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      // Access check: linked attachments require field visibility; pending require uploader-or-manage
      const userRoleNames = user.roles.map((r) => r.name);
      const userGroupNames = user.groups.map((g) => g.name);
      const hasManage = user.roles.some((r) => r.permissions.includes(Permissions.TASKS_MANAGE));

      if (att.status === AttachmentStatus.LINKED && att.fieldKey) {
        // Field visibility only applies to published forms. An ad-hoc task's
        // inline form has no visibility rules, so its attachments are visible to
        // anyone who can see the task.
        if (task.taskDefinition && task.formDefinitionVersion !== null) {
          const form = await app.db.getRepository(FormDefinition).findOne({
            where: {
              code: task.taskDefinition.formDefinitionCode,
              version: task.formDefinitionVersion,
            },
          });
          if (form) {
            const { jsonSchema } = filterFormSchemas(form, userRoleNames, userGroupNames);
            const visibleFields = new Set(
              Object.keys((jsonSchema.properties ?? {}) as Record<string, unknown>),
            );
            if (!visibleFields.has(att.fieldKey)) {
              return reply.code(403).send({ error: 'Access denied' });
            }
          }
        }
      } else if (att.status === AttachmentStatus.PENDING) {
        if (att.uploadedById !== user.id && !hasManage) {
          return reply.code(403).send({ error: 'Access denied' });
        }
      }

      const stream = await app.attachmentStore.get(att.storageKey);

      reply
        .header('Content-Type', att.contentType)
        .header('Content-Disposition', `attachment; filename="${att.fileName.replace(/"/g, '\\"')}"`)
        .header('Content-Length', String(att.size));

      return reply.send(stream);
    },
  );
};
