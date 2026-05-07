import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5173';

test.describe('Form Designer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await page.fill('input[type="email"], input[name="email"]', 'alice@example.com');
    await page.fill('input[type="password"], input[name="password"]', 'password');
    await page.click('button[type="submit"]');
    // Navigate to Forms
    const formsLink = page.locator('text=Forms').or(page.locator('text=Designer')).first();
    await formsLink.click();
    await expect(page.locator('.form-sidebar')).toBeVisible({ timeout: 5000 });
  });

  test('create form, switch tabs, save, and publish', async ({ page }) => {
    // Create a new form
    const formCode = `E2E_${Date.now()}`;
    await page.fill('.new-form input', formCode);
    await page.click('.new-form button');

    // Wait for designer to load with three-panel layout
    await expect(page.locator('.designer-toolbar')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.field-palette')).toBeVisible();
    await expect(page.locator('.form-canvas')).toBeVisible();
    await expect(page.locator('.canvas-empty')).toBeVisible();

    // Switch to Source tab — Monaco editor should show empty schema with builder marker
    await page.click('button:has-text("Source")');
    await expect(page.locator('.form-editor')).toBeVisible({ timeout: 5000 });

    // Switch to Preview tab
    await page.click('button:has-text("Preview")');
    await expect(page.locator('.form-preview')).toBeVisible({ timeout: 5000 });

    // Switch back to Designer
    await page.click('button:has-text("Designer")');
    await expect(page.locator('.form-canvas')).toBeVisible();

    // Save draft
    await page.click('button:has-text("Save draft")');
    await page.waitForTimeout(500);

    // Publish
    await page.click('button:has-text("Publish")');

    // Verify version appears in sidebar
    await expect(
      page.locator(`.form-item:has-text("${formCode}") .version`)
    ).toBeVisible({ timeout: 5000 });
  });

  test('LOAN_APPLICATION loads fields in designer', async ({ page }) => {
    // Click on LOAN_APPLICATION
    await page.click('.form-item:has-text("LOAN_APPLICATION")');
    await expect(page.locator('.form-workspace')).toBeVisible({ timeout: 5000 });

    // Create draft if needed
    const createDraftBtn = page.locator('button:has-text("Create draft")');
    if (await createDraftBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await createDraftBtn.click();
    }

    // Designer tab should show fields from published schema
    await expect(page.locator('.designer-toolbar')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.canvas-field')).toHaveCount(4, { timeout: 5000 });

    // Verify Source tab shows the schema
    await page.click('button:has-text("Source")');
    await expect(page.locator('.form-editor')).toBeVisible({ timeout: 5000 });
  });
});
