import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5173';

test.describe('Flowstile UI smoke test', () => {
  test('login page loads', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('text=Flowstile')).toBeVisible();
    await expect(page.locator('input[type="email"], input[name="email"]')).toBeVisible();
  });

  test('login with alice and see inbox', async ({ page }) => {
    await page.goto(BASE);

    // Fill login form
    await page.fill('input[type="email"], input[name="email"]', 'alice@example.com');
    await page.fill('input[type="password"], input[name="password"]', 'password');
    await page.click('button[type="submit"]');

    // Should redirect to inbox / tasks view
    await expect(page.locator('text=Inbox').or(page.locator('text=Tasks')).first()).toBeVisible({ timeout: 5000 });
  });

  test('alice can see seeded tasks', async ({ page }) => {
    await page.goto(BASE);
    await page.fill('input[type="email"], input[name="email"]', 'alice@example.com');
    await page.fill('input[type="password"], input[name="password"]', 'password');
    await page.click('button[type="submit"]');

    // Wait for task list to load — look for loan-related content from seed data
    await page.waitForTimeout(1000);
    const body = await page.textContent('body');
    expect(body).toContain('LN-2024');
  });

  test('alice can navigate to admin page', async ({ page }) => {
    await page.goto(BASE);
    await page.fill('input[type="email"], input[name="email"]', 'alice@example.com');
    await page.fill('input[type="password"], input[name="password"]', 'password');
    await page.click('button[type="submit"]');

    // Look for admin link/nav
    const adminLink = page.locator('text=Admin').first();
    await expect(adminLink).toBeVisible({ timeout: 5000 });
    await adminLink.click();

    // Should see user management
    await expect(page.locator('text=alice@example.com')).toBeVisible({ timeout: 5000 });
  });

  test('alice can navigate to form designer', async ({ page }) => {
    await page.goto(BASE);
    await page.fill('input[type="email"], input[name="email"]', 'alice@example.com');
    await page.fill('input[type="password"], input[name="password"]', 'password');
    await page.click('button[type="submit"]');

    const formsLink = page.locator('text=Forms').or(page.locator('text=Designer')).first();
    await expect(formsLink).toBeVisible({ timeout: 5000 });
    await formsLink.click();

    // Should see the seeded LOAN_APPLICATION form
    await expect(page.locator('text=LOAN_APPLICATION')).toBeVisible({ timeout: 5000 });
  });

  test('bob cannot see admin page', async ({ page }) => {
    await page.goto(BASE);
    await page.fill('input[type="email"], input[name="email"]', 'bob@example.com');
    await page.fill('input[type="password"], input[name="password"]', 'password');
    await page.click('button[type="submit"]');

    await page.waitForTimeout(1000);
    // Bob has tasks:read + tasks:write only, no users:manage — admin should not appear
    const adminLinks = await page.locator('a:has-text("Admin"), button:has-text("Admin")').count();
    expect(adminLinks).toBe(0);
  });
});
