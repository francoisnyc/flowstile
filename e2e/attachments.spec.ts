import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

const BASE = 'http://localhost:5173';
const SERVER = 'http://localhost:3000';

async function loginUi(page: Page, email: string) {
  await page.goto(BASE);
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', 'password');
  await page.click('button[type="submit"]');
  await expect(page.locator('text=Inbox').or(page.locator('text=Tasks')).first())
    .toBeVisible({ timeout: 10000 });
}

// Authenticated API helper. Returns a token for the given user plus a request fn.
async function tokenFor(email: string): Promise<string> {
  const loginRes = await fetch(`${SERVER}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password' }),
  });
  const cookie = loginRes.headers.get('set-cookie') ?? '';
  return cookie.match(/flowstile_token=([^;]+)/)?.[1] ?? '';
}

async function api(method: string, path: string, body?: unknown, email = 'alice@example.com'): Promise<any> {
  const token = await tokenFor(email);
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Sets up a published form with a single-file attachment field, a process, a
// task definition, and a created task. Returns the ids needed by each test.
async function setupAttachmentTask(tag: number) {
  const formCode = `E2E_ATT_${tag}`;
  await api('POST', '/forms', {
    code: formCode,
    jsonSchema: {
      type: 'object',
      properties: {
        NOTES: { type: 'string' },
        DOCUMENT: {
          'x-flowstile-attachment': { accept: ['text/plain'], maxSize: 1_000_000 },
        },
      },
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/NOTES' },
        { type: 'Control', scope: '#/properties/DOCUMENT', label: 'Document' },
      ],
    },
  });
  await api('POST', `/forms/${formCode}/publish`);

  const { body: process } = await api('POST', '/processes', { name: `E2E Attachments ${tag}` });
  const taskDefCode = `E2E_ATT_DEF_${tag}`;
  const { body: taskDef } = await api('POST', `/processes/${process.id}/tasks`, {
    code: taskDefCode,
    formDefinitionCode: formCode,
    candidateGroups: [],
    candidateUsers: [],
  });
  const { body: task } = await api('POST', '/tasks', {
    taskDefinitionId: taskDef.id,
    workflowId: `e2e-att-wf-${tag}`,
  });

  return { formCode, taskDefCode, task };
}

// Uploads a file via the API and returns the reference object.
async function uploadViaApi(taskId: string, content: string, fileName = 'note.txt') {
  const token = await tokenFor('alice@example.com');
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), fileName);
  const res = await fetch(`${SERVER}/tasks/${taskId}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

test.describe('Attachments', () => {
  test('upload → complete → download returns identical bytes', async () => {
    const { task } = await setupAttachmentTask(Date.now());
    const content = 'Hello attachments — end to end!';

    // Claim, then upload a file
    await api('POST', `/tasks/${task.id}/claim`);
    const { status: upStatus, body: ref } = await uploadViaApi(task.id, content);
    expect(upStatus).toBe(201);
    expect(ref.attachmentId).toBeTruthy();
    expect(ref.checksum).toBe(createHash('sha256').update(content).digest('hex'));

    // Complete the task with the reference in submissionData
    const { status: completeStatus } = await api('POST', `/tasks/${task.id}/complete`, {
      data: { DOCUMENT: ref },
    });
    expect(completeStatus).toBe(200);

    // Download via API and verify the bytes match exactly
    const token = await tokenFor('alice@example.com');
    const dlRes = await fetch(`${SERVER}/tasks/${task.id}/attachments/${ref.attachmentId}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('content-disposition')).toContain('note.txt');
    const downloaded = await dlRes.text();
    expect(downloaded).toBe(content);
  });

  test('uploads and downloads a file through the task UI', async ({ page }) => {
    const { taskDefCode, task } = await setupAttachmentTask(Date.now() + 1);

    await loginUi(page, 'alice@example.com');

    const card = page.locator(`.task-card:has-text("${taskDefCode}")`).first();
    await expect(card).toBeVisible({ timeout: 8000 });
    await card.click();

    await expect(page.locator('.task-detail h2')).toBeVisible({ timeout: 5000 });
    await page.click('button:has-text("Claim")');
    await expect(page.locator('.status-badge')).toContainText('claimed', { timeout: 5000 });

    // The attachment field renders with its Attach button
    const fileField = page.locator('.file-field[data-field-key="DOCUMENT"]');
    await expect(fileField).toBeVisible();

    // Upload a file through the hidden input
    const content = 'UI-uploaded document body';
    await fileField.locator('input[type="file"]').setInputFiles({
      name: 'ui-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(content),
    });

    // The uploaded ref shows as a download link
    const link = fileField.locator('.file-ref a');
    await expect(link).toHaveText('ui-note.txt', { timeout: 8000 });

    // Complete the task — the attachment ref is in form data
    await page.click('.task-actions button:has-text("Complete")');
    await expect(page.locator('.status-badge')).toContainText('completed', { timeout: 8000 });

    // Verify via API that the attachment is linked under DOCUMENT
    const { body: completed } = await api('GET', `/tasks/${task.id}`);
    const ref = completed.submissionData.DOCUMENT;
    expect(ref?.attachmentId).toBeTruthy();
    expect(ref.fileName).toBe('ui-note.txt');

    // And the bytes round-trip
    const token = await tokenFor('alice@example.com');
    const dlRes = await fetch(`${SERVER}/tasks/${task.id}/attachments/${ref.attachmentId}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await dlRes.text()).toBe(content);
  });

  test('download of a hidden-field attachment by an ineligible user is denied', async () => {
    const tag = Date.now() + 2;
    const formCode = `E2E_ATT_VIS_${tag}`;

    // Form where DOCUMENT is only visible to the loan-officers group
    await api('POST', '/forms', {
      code: formCode,
      jsonSchema: {
        type: 'object',
        properties: {
          DOCUMENT: { 'x-flowstile-attachment': { accept: ['text/plain'] } },
        },
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/DOCUMENT' }],
      },
      visibilityRules: { DOCUMENT: { allowedGroups: ['loan-officers'] } },
    });
    await api('POST', `/forms/${formCode}/publish`);

    const { body: process } = await api('POST', '/processes', { name: `E2E Att Vis ${tag}` });
    const { body: taskDef } = await api('POST', `/processes/${process.id}/tasks`, {
      code: `E2E_ATT_VIS_DEF_${tag}`,
      formDefinitionCode: formCode,
      candidateGroups: [],
      candidateUsers: [],
    });
    const { body: task } = await api('POST', '/tasks', {
      taskDefinitionId: taskDef.id,
      workflowId: `e2e-att-vis-wf-${tag}`,
    });

    // alice (loan-officers member, admin) claims, uploads, completes
    await api('POST', `/tasks/${task.id}/claim`);
    const { body: ref } = await uploadViaApi(task.id, 'secret document');
    await api('POST', `/tasks/${task.id}/complete`, { data: { DOCUMENT: ref } });

    // carol (customer-service, NOT loan-officers) cannot download the linked attachment
    const carolToken = await tokenFor('carol@example.com');
    const dlRes = await fetch(`${SERVER}/tasks/${task.id}/attachments/${ref.attachmentId}/content`, {
      headers: { Authorization: `Bearer ${carolToken}` },
    });
    expect(dlRes.status).toBe(403);

    // alice (loan-officers) still can
    const aliceToken = await tokenFor('alice@example.com');
    const okRes = await fetch(`${SERVER}/tasks/${task.id}/attachments/${ref.attachmentId}/content`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(okRes.status).toBe(200);
  });
});
