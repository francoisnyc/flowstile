import { test, expect, request } from '@playwright/test';

// Chat-as-form (rung 4), hermetic: the human is driven through the real UI while
// the test plays a deterministic agent over the API (posting replies + patching
// the draft). No external model — exercises the full server + UI + message +
// draft + completion path. The agent *runner* is unit-tested separately in the
// Python SDK; here we prove the human-facing mechanism end to end.

const BASE = 'http://localhost:5173';
const API = process.env.FLOWSTILE_SERVER_URL ?? 'http://localhost:3000';
const KEY = process.env.FLOWSTILE_API_KEY ?? 'fsk_dev_local_worker_DO_NOT_USE_IN_PROD';

test('chat task: agent gathers by conversation, human commits', async ({ page }) => {
  const api = await request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Authorization: `Bearer ${KEY}` },
  });

  const stamp = Date.now();
  const name = `Chat intake ${stamp}`;
  const pid = `chat-e2e-${stamp}`;

  // 1) Create the chat task (routed to Alice), which seeds the greeting.
  const created = await api.post('/tasks', {
    data: {
      workflowId: pid,
      processInstanceId: pid,
      name,
      candidateUsers: ['alice@example.com'],
      formSchema: {
        type: 'object',
        properties: { severity: { type: 'string' }, service: { type: 'string' } },
        required: ['severity'],
      },
      chat: { agent: 'e2e', goal: 'Collect severity and service.', greeting: 'What is happening?' },
    },
  });
  expect(created.ok()).toBeTruthy();
  const taskId = (await created.json()).id as string;

  // The deterministic "agent": patch the draft, then post the next question.
  const agentRespond = async (field: string, value: string, nextQuestion: string) => {
    await api.patch(`/tasks/${taskId}/submission`, { data: { data: { [field]: value } } });
    await api.post(`/tasks/${taskId}/messages`, { data: { content: nextQuestion } });
  };

  // 2) Human logs in and opens the task.
  await page.goto(BASE);
  await page.fill('input[type="email"]', 'alice@example.com');
  await page.fill('input[type="password"]', 'password');
  await page.click('button[type="submit"]');
  await page.locator('.task-card', { hasText: name }).click();

  await expect(page.locator('[data-testid=chat-panel]')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('.chat-bubble.agent')).toContainText('What is happening?');

  // 3) Claim to engage + eventually complete. Target the status badge by its
  // status class — a chat task also has a ".status-badge.chat" badge.
  await page.locator('button:has-text("Claim")').click();
  await expect(page.locator('.task-detail .status-badge.claimed')).toBeVisible({ timeout: 8000 });

  // 4) Turn one: human answers, agent responds (played via API); UI polls it in.
  await page.locator('[data-testid=chat-textarea]').fill('high');
  await page.locator('[data-testid=chat-send]').click();
  await expect(page.locator('.chat-bubble.human')).toContainText('high');
  await agentRespond('severity', 'high', 'Which service is affected?');
  await expect(page.locator('.chat-bubble.agent', { hasText: 'Which service is affected?' }))
    .toBeVisible({ timeout: 6000 });

  // 5) Turn two.
  await page.locator('[data-testid=chat-textarea]').fill('orders-db');
  await page.locator('[data-testid=chat-send]').click();
  await agentRespond('service', 'orders-db', 'Thanks — review the draft and click Complete.');
  await expect(page.locator('.chat-bubble.agent', { hasText: 'review the draft' }))
    .toBeVisible({ timeout: 6000 });

  // 6) Human commits. Completion merges the agent-patched draft server-side, so
  // the result carries the conversation-derived data.
  await page.locator('button:has-text("Complete")').click();
  await expect(page.locator('.task-detail .status-badge.completed')).toBeVisible({ timeout: 8000 });

  const final = await (await api.get(`/tasks/${taskId}`)).json();
  expect(final.status).toBe('completed');
  expect(final.submissionData).toMatchObject({ severity: 'high', service: 'orders-db' });

  await api.dispose();
});
