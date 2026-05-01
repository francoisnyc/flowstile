import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5173';

async function loginAs(page: import('@playwright/test').Page, email: string) {
  await page.goto(BASE);
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', 'password');
  await page.click('button[type="submit"]');
  await expect(page.locator('text=Inbox').or(page.locator('text=Tasks')).first()).toBeVisible({ timeout: 5000 });
}

test.describe('Task workflow', () => {
  test('screenshot the inbox view', async ({ page }) => {
    await loginAs(page, 'alice@example.com');
    await page.screenshot({ path: '/tmp/flowstile-inbox.png', fullPage: true });
  });

  test('screenshot the form designer', async ({ page }) => {
    await loginAs(page, 'alice@example.com');
    const formsLink = page.locator('text=Forms').or(page.locator('text=Designer')).first();
    await formsLink.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/flowstile-form-designer.png', fullPage: true });
  });

  test('screenshot the admin page', async ({ page }) => {
    await loginAs(page, 'alice@example.com');
    await page.locator('text=Admin').first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/flowstile-admin.png', fullPage: true });
  });
});
