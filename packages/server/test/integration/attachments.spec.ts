import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { FormDefinition } from '../../src/entities/form-definition.entity.js';
import { TaskDefinition } from '../../src/entities/task-definition.entity.js';
import { ProcessDefinition } from '../../src/entities/process-definition.entity.js';
import { Task } from '../../src/entities/task.entity.js';
import { Attachment } from '../../src/entities/attachment.entity.js';
import { AttachmentStatus, FormDefinitionStatus, Priority } from '../../src/common/enums.js';
import { Permissions } from '../../src/common/permissions.js';
import {
  createTestUser,
  loginAs,
  authed,
  cleanupTestData,
} from './helpers.js';

let app: FastifyInstance;
let cookie: string;
let taskId: string;
let formCode: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const tag = Date.now();
  formCode = `ATT_FORM_${tag}`;

  // Form with one attachment field
  await app.db.getRepository(FormDefinition).save({
    code: formCode,
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        // Attachment fields hold an object (the reference), not a string.
        // No type constraint here; validateAndCollectReferences validates the shape.
        doc: {
          'x-flowstile-attachment': { accept: ['text/plain'], maxSize: 10_000 },
        },
      },
    },
    uiSchema: { type: 'VerticalLayout', elements: [] },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const proc = await app.db.getRepository(ProcessDefinition).save({ name: `Att Proc ${tag}` });
  const td = await app.db.getRepository(TaskDefinition).save({
    code: `ATT_TASK_${tag}`,
    processDefinitionId: proc.id,
    formDefinitionCode: formCode,
    candidateGroups: [],
    candidateUsers: [],
    defaultPriority: Priority.NORMAL,
  });

  const user = await createTestUser(app, {
    permissions: [Permissions.TASKS_READ, Permissions.TASKS_WRITE, Permissions.TASKS_MANAGE],
  });
  cookie = await loginAs(app, user.email);

  // Create + claim a task
  const createRes = await authed(app, cookie, {
    method: 'POST',
    url: '/tasks',
    payload: { taskDefinitionId: td.id, workflowId: 'wf-att-test' },
  });
  expect(createRes.statusCode).toBe(201);
  taskId = JSON.parse(createRes.body).id;

  await authed(app, cookie, { method: 'POST', url: `/tasks/${taskId}/claim` });
});

afterAll(async () => {
  await app.db.getRepository(Attachment).createQueryBuilder().delete().execute();
  await app.db.getRepository(Task).createQueryBuilder().delete().execute();
  await app.db.getRepository(TaskDefinition).createQueryBuilder()
    .delete().where('code LIKE :p', { p: 'ATT_TASK_%' }).execute();
  await app.db.getRepository(ProcessDefinition).createQueryBuilder()
    .delete().where('name LIKE :p', { p: 'Att Proc%' }).execute();
  await app.db.getRepository(FormDefinition).createQueryBuilder()
    .delete().where('code LIKE :p', { p: 'ATT_FORM_%' }).execute();
  await cleanupTestData(app);
  await app.close();
});

async function uploadFile(content: string, filename = 'test.txt', mime = 'text/plain') {
  const boundary = 'test-boundary-123';
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${mime}`,
    '',
    content,
    `--${boundary}--`,
  ].join('\r\n');

  return authed(app, cookie, {
    method: 'POST',
    url: `/tasks/${taskId}/attachments`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
}

describe('POST /tasks/:id/attachments', () => {
  it('uploads a file and returns a pending reference', async () => {
    const res = await uploadFile('hello attachment');
    expect(res.statusCode).toBe(201);
    const ref = JSON.parse(res.body);
    expect(ref.attachmentId).toBeTruthy();
    expect(ref.fileName).toBe('test.txt');
    expect(ref.contentType).toBe('text/plain');
    expect(ref.size).toBe(Buffer.byteLength('hello attachment'));
    expect(ref.checksum).toBe(createHash('sha256').update('hello attachment').digest('hex'));
  });

  it('returns 404 for unknown task', async () => {
    const boundary = 'b123';
    const body = [`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="x.txt"', 'Content-Type: text/plain', '', 'x', `--${boundary}--`].join('\r\n');
    const res = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks/00000000-0000-4000-8000-000000000001/attachments',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /tasks/:id/attachments/:attachmentId/content', () => {
  it('downloads uploaded content with correct headers', async () => {
    const content = 'download-me';
    const upRes = await uploadFile(content, 'dl.txt');
    expect(upRes.statusCode).toBe(201);
    const { attachmentId } = JSON.parse(upRes.body);

    const dlRes = await authed(app, cookie, {
      method: 'GET',
      url: `/tasks/${taskId}/attachments/${attachmentId}/content`,
    });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.body).toBe(content);
    expect(dlRes.headers['content-type']).toContain('text/plain');
    expect(dlRes.headers['content-disposition']).toContain('dl.txt');
  });

  it('returns 404 for attachment from a different task', async () => {
    const upRes = await uploadFile('other');
    const { attachmentId } = JSON.parse(upRes.body);
    const res = await authed(app, cookie, {
      method: 'GET',
      url: `/tasks/00000000-0000-4000-8000-000000000001/attachments/${attachmentId}/content`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('attachment linking on task completion', () => {
  it('completes a task with an attachment reference and links the attachment', async () => {
    // Upload
    const upRes = await uploadFile('linked-file');
    expect(upRes.statusCode).toBe(201);
    const ref = JSON.parse(upRes.body);
    const attId = ref.attachmentId;

    // Complete with the reference in submissionData
    const completeRes = await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${taskId}/complete`,
      payload: { data: { doc: ref } },
    });
    expect(completeRes.statusCode).toBe(200);

    // Verify the attachment is now linked
    const att = await app.db.getRepository(Attachment).findOneBy({ id: attId });
    expect(att?.status).toBe(AttachmentStatus.LINKED);
    expect(att?.fieldKey).toBe('doc');
    expect(att?.payloadScope).toBe('submission');
    expect(att?.linkedAt).toBeTruthy();
  });
});
