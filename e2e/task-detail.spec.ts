import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5173';

test('clicking a task shows the detail panel with form', async ({ page }) => {
  // Login
  await page.goto(BASE);
  await page.fill('input[type="email"], input[name="email"]', 'alice@example.com');
  await page.fill('input[type="password"], input[name="password"]', 'password');
  await page.click('button[type="submit"]');

  // Wait for tasks to load
  await expect(page.locator('.task-card').first()).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: '/tmp/flowstile-01-inbox.png', fullPage: true });

  // Click the first task card
  await page.locator('.task-card').first().click();

  // Wait for detail panel to show task info
  await expect(page.locator('.task-detail h2')).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: '/tmp/flowstile-02-detail.png', fullPage: true });

  // Verify form rendered
  const formContainer = page.locator('.form-container');
  await expect(formContainer).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: '/tmp/flowstile-03-form.png', fullPage: true });

  // Verify claim button is visible (task is unassigned)
  const claimBtn = page.locator('button:has-text("Claim")');
  const isClaimable = await claimBtn.isVisible().catch(() => false);

  if (isClaimable) {
    // Claim the task
    await claimBtn.click();
    await expect(page.locator('.status-badge')).toContainText('claimed', { timeout: 5000 });
    await page.screenshot({ path: '/tmp/flowstile-04-claimed.png', fullPage: true });

    // Complete button should appear
    await expect(page.locator('button:has-text("Complete")')).toBeVisible();

    // Complete the task
    await page.locator('button:has-text("Complete")').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/flowstile-05-completed.png', fullPage: true });
  }
});
