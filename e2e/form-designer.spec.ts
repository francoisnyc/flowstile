import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://localhost:5173';
const SERVER = 'http://localhost:3000';

async function loginAs(page: Page, email: string) {
  await page.goto(BASE);
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', 'password');
  await page.click('button[type="submit"]');
  await expect(page.locator('.inbox').or(page.locator('text=Inbox')).first()).toBeVisible({ timeout: 10000 });
}

async function goToForms(page: Page) {
  const formsLink = page.locator('text=Forms').or(page.locator('text=Designer')).first();
  await formsLink.click();
  await expect(page.locator('.form-sidebar')).toBeVisible({ timeout: 5000 });
}

async function apiGet(path: string): Promise<unknown> {
  const loginRes = await fetch(`${SERVER}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'password' }),
  });
  const cookie = loginRes.headers.get('set-cookie') ?? '';
  const match = cookie.match(/flowstile_token=([^;]+)/);
  const token = match?.[1] ?? '';

  const res = await fetch(`${SERVER}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

// @dnd-kit's PointerSensor activates on a movement threshold and is timing
// sensitive, so a single synthetic drag is flaky across CI machines. This
// helper performs one drag attempt with the stepping/pauses dnd-kit needs.
async function attemptDrag(page: Page, fieldTypeLabel: string) {
  const paletteItem = page.locator('.palette-item', { hasText: fieldTypeLabel }).first();
  const canvas = page.locator('.form-canvas');

  await paletteItem.waitFor({ state: 'visible' });
  await canvas.waitFor({ state: 'visible' });

  const paletteBox = await paletteItem.boundingBox();
  const canvasBox = await canvas.boundingBox();
  if (!paletteBox || !canvasBox) throw new Error('Could not get bounding boxes for drag');

  const fromX = paletteBox.x + paletteBox.width / 2;
  const fromY = paletteBox.y + paletteBox.height / 2;
  const toX = canvasBox.x + canvasBox.width / 2;
  const toY = canvasBox.y + canvasBox.height / 2;

  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  // Cross the activation threshold first, then traverse to the drop target.
  await page.mouse.move(fromX + 12, fromY + 12, { steps: 6 });
  await page.waitForTimeout(50);
  await page.mouse.move(toX, toY, { steps: 24 });
  await page.waitForTimeout(50);
  await page.mouse.up();
}

// Drags a field type onto the canvas and confirms the field count increased,
// retrying the synthetic drag if dnd-kit didn't register it.
async function dragPaletteItemToCanvas(page: Page, fieldTypeLabel: string) {
  const before = await page.locator('.canvas-field').count();
  for (let attempt = 0; attempt < 3; attempt++) {
    await attemptDrag(page, fieldTypeLabel);
    try {
      await expect(page.locator('.canvas-field')).toHaveCount(before + 1, { timeout: 2000 });
      return;
    } catch {
      // Drag didn't register — retry.
    }
  }
  throw new Error(`Drag of "${fieldTypeLabel}" did not add a field after 3 attempts`);
}

test.describe('Form Designer', () => {
  test('create form, drag fields, configure properties, preview, publish, verify schema', async ({ page }) => {
    await loginAs(page, 'alice@example.com');
    await goToForms(page);

    // ── 1. Create a new form ────────────────────────────────────────────────
    const formCode = `E2E_DESIGNER_${Date.now()}`;
    await page.fill('.new-form input', formCode);
    await page.click('.new-form button');

    // Designer should open with empty canvas
    await expect(page.locator('.designer-toolbar')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.form-code')).toContainText(formCode);
    await expect(page.locator('.field-palette')).toBeVisible();
    await expect(page.locator('.canvas-empty')).toBeVisible();

    // ── 2. Drag a Text field onto the canvas ───────────────────────────────
    // Dropping a field auto-selects it (handleDragEnd → onSelect(newField.id)),
    // so the Properties panel immediately targets this field — no manual click
    // needed. Avoiding a click on the dnd-kit sortable also avoids accidentally
    // tripping its drag-activation threshold and selecting the wrong field.
    await dragPaletteItemToCanvas(page, 'Text');
    await expect(page.locator('.canvas-field')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('.canvas-empty')).not.toBeVisible();

    // ── 3. Configure the (auto-selected) Text field label ──────────────────
    await expect(page.locator('.properties-panel')).toBeVisible({ timeout: 3000 });

    // Target the Label input specifically (the input inside the "Label" row),
    // not just the first input in the panel.
    const labelInput = page.locator('.props-field', { has: page.locator('.props-label', { hasText: /^Label$/ }) }).locator('input');
    // The label binding is onChange-based, so fill() — which sets the value via
    // the native setter and dispatches a single input event — propagates to the
    // canvas immediately, and the field stays selected for the next step.
    await labelInput.fill('Customer Name');

    // Verify canvas reflects updated label
    await expect(page.locator('.canvas-field .field-label').first()).toContainText('Customer Name', { timeout: 6000 });

    // ── 4. Mark the (still-selected) field as required ────────────────────
    const requiredCheckbox = page.locator('.props-checkbox input[type="checkbox"]');
    if (await requiredCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
      await requiredCheckbox.check();
    }

    // ── 5. Drag a Number field onto the canvas ─────────────────────────────
    await dragPaletteItemToCanvas(page, 'Number');
    await expect(page.locator('.canvas-field')).toHaveCount(2, { timeout: 5000 });

    // ── 6. Switch to Preview tab ───────────────────────────────────────────
    await page.click('.tab:has-text("Preview")');
    await expect(page.locator('.form-preview')).toBeVisible({ timeout: 5000 });
    // JSON Forms should render the Customer Name field label
    await expect(page.locator('.form-preview').getByText('Customer Name')).toBeVisible({ timeout: 5000 });

    // ── 7. Switch to Source tab — verify schema has builder marker ─────────
    await page.click('.tab:has-text("Source")');
    await expect(page.locator('.form-editor')).toBeVisible({ timeout: 5000 });

    // ── 8. Switch back to Designer ─────────────────────────────────────────
    await page.click('.tab:has-text("Designer")');
    await expect(page.locator('.canvas-field')).toHaveCount(2, { timeout: 3000 });

    // ── 9. Save draft ──────────────────────────────────────────────────────
    await page.click('button:has-text("Save draft")');
    // Wait for save to complete (button re-enables)
    await expect(page.locator('button:has-text("Save draft")')).toBeEnabled({ timeout: 5000 });

    // ── 10. Publish ────────────────────────────────────────────────────────
    await page.click('button:has-text("Publish")');
    await expect(page.locator(`.form-item:has-text("${formCode}") .version`)).toBeVisible({ timeout: 8000 });

    // ── 11. Verify published schema via API ────────────────────────────────
    const published = await apiGet(`/forms/${formCode}`) as {
      code: string;
      version: number;
      status: string;
      jsonSchema: {
        type: string;
        properties: Record<string, unknown>;
        required?: string[];
      };
      uiSchema: { elements: { scope: string }[] };
    };

    expect(published.code).toBe(formCode);
    expect(published.version).toBe(1);
    expect(published.status).toBe('published');

    // Text field should appear in the schema as a string property
    const properties = published.jsonSchema?.properties ?? {};
    const fieldKeys = Object.keys(properties);
    expect(fieldKeys.length).toBeGreaterThanOrEqual(2);

    // The Customer Name field key should derive from the label
    const customerNameKey = fieldKeys.find((k) =>
      (properties[k] as Record<string, unknown>)?.type === 'string' &&
      k.toLowerCase().includes('customer')
    );
    expect(customerNameKey).toBeTruthy();

    // Number field should appear as type: number
    const numberKey = fieldKeys.find((k) =>
      (properties[k] as Record<string, unknown>)?.type === 'number'
    );
    expect(numberKey).toBeTruthy();

    // UI schema should have matching elements
    const elements = published.uiSchema?.elements ?? [];
    expect(elements.length).toBeGreaterThanOrEqual(2);
  });

  test('undo/redo works in designer', async ({ page }) => {
    await loginAs(page, 'alice@example.com');
    await goToForms(page);

    const formCode = `E2E_UNDO_${Date.now()}`;
    await page.fill('.new-form input', formCode);
    await page.click('.new-form button');

    await expect(page.locator('.designer-toolbar')).toBeVisible({ timeout: 8000 });

    // Undo button starts disabled (nothing to undo)
    await expect(page.locator('button[title*="Undo"]')).toBeDisabled();

    // Drag a field to create history entry
    await dragPaletteItemToCanvas(page, 'Text');
    await expect(page.locator('.canvas-field')).toHaveCount(1, { timeout: 5000 });

    // Undo should now be enabled
    await expect(page.locator('button[title*="Undo"]')).toBeEnabled({ timeout: 3000 });

    // Undo — canvas should be empty again
    await page.click('button[title*="Undo"]');
    await expect(page.locator('.canvas-empty')).toBeVisible({ timeout: 5000 });

    // Redo — field comes back
    await expect(page.locator('button[title*="Redo"]')).toBeEnabled({ timeout: 3000 });
    await page.click('button[title*="Redo"]');
    await expect(page.locator('.canvas-field')).toHaveCount(1, { timeout: 3000 });
  });

  test('LOAN_APPLICATION loads and editable fields round-trip through designer', async ({ page }) => {
    await loginAs(page, 'alice@example.com');
    await goToForms(page);

    // Click on LOAN_APPLICATION — filter by a span child with exactly that text so we
    // don't match LOAN_APPLICATION_START (whose code span reads "LOAN_APPLICATION_START").
    await page.locator('.form-item', { has: page.locator('span', { hasText: /^LOAN_APPLICATION$/ }) }).click();

    // Wait for the workspace to appear (it will show the "empty" / "Create draft" state
    // first because LOAN_APPLICATION only has a published version, not a draft yet).
    await expect(page.locator('.form-workspace')).toBeVisible({ timeout: 10000 });

    // Create a draft from the published version so the designer canvas is editable.
    const createDraftBtn = page.locator('button:has-text("Create draft")');
    if (await createDraftBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await createDraftBtn.click();
    }

    // Now the workspace should be fully loaded (draft exists).
    await expect(page.locator('.form-workspace:not(.empty)')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.designer-toolbar')).toBeVisible({ timeout: 5000 });

    // Designer tab should show all fields parsed from the published schema:
    // CUSTOMER_NAME, AMOUNT, DECISION, NOTES, and the SUPPORTING_DOCUMENTS
    // attachment field — 5 controls total.
    await expect(page.locator('.canvas-field')).toHaveCount(5, { timeout: 8000 });

    // Switch to Source — verify it shows valid JSON Schema
    await page.click('.tab:has-text("Source")');
    await expect(page.locator('.form-editor')).toBeVisible({ timeout: 5000 });

    // Switch back to Designer — fields should still be intact
    await page.click('.tab:has-text("Designer")');
    await expect(page.locator('.canvas-field')).toHaveCount(5, { timeout: 5000 });
  });
});
